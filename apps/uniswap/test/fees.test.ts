import { expect, test } from "bun:test";
import { createEvmWalletClient, type EvmEstimateTransactionRequest, type EvmEstimateTransactionResult } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { estimateSwapFees, readFeeEstimates, totalEstimatedFee } from "../src/fees.ts";
import { defaultTokens, swapTransaction, type PreparedSwap, type Quote, type Transaction } from "../src/swap.ts";

const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const ROUTER = getAddress("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45");
const QUOTER = getAddress("0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
function prepared(chainId = "1", approval = true): PreparedSwap {
  const [native, usdc, wrapped] = defaultTokens(chainId);
  const quote: Quote = {
    accountId: "main", accountAddress: ACCOUNT, chainId, tokenIn: approval ? usdc! : native!, tokenOut: approval ? wrapped! : usdc!,
    amountIn: "1000000", amountOut: "2000000", minimumOut: "1990000", slippageBps: 50, recipient: ACCOUNT,
    deadline: "2000000000", router: ROUTER, quoter: QUOTER, fee: 500, gasEstimate: "90000", priceImpactBps: null,
    quotedAtMs: 1800000000000, blockNumber: "21000000", pool: null, routeWarnings: [],
  };
  const approvalTransaction: Transaction | null = approval ? { accountId: "main", chainId, to: usdc!.address!, value: "0", data: "0x095ea7b3" } : null;
  return { quote, approval: approvalTransaction, swap: swapTransaction(quote, 0), allowance: approval ? "0" : null };
}
function estimate(request: EvmEstimateTransactionRequest, price = 3_000_000_000n): EvmEstimateTransactionResult {
  const gas = request.to.toLowerCase() === ROUTER.toLowerCase() ? 130000n : 50000n;
  return {
    ...request, address: ACCOUNT, status: "available", gasLimit: gas.toString(), gasPriceWei: price.toString(),
    baseFeePerGasWei: (price - 1n).toString(), maxPriorityFeePerGasWei: "1", maxFeePerGasWei: (2n * price - 1n).toString(),
    estimatedFeeWei: (gas * price).toString(), maximumFeeWei: (gas * (2n * price - 1n)).toString(),
    blockNumber: "21000000", observedAtNs: "1800000000000000000", source: "evm_rpc",
    feeBasis: request.chainId === "42161" ? "arbitrum_total_gas" : "base_fee_plus_priority",
    postingCosts: request.chainId === "42161" ? "included" : "not_applicable", reasons: [],
  };
}
function client(respond: (request: EvmEstimateTransactionRequest) => unknown | Promise<unknown>) {
  const calls: EvmEstimateTransactionRequest[] = [];
  const wallet = createEvmWalletClient({ callTool: async (call) => {
    expect(call.target).toBe("app:evm_wallet:background");
    expect(call.name).toBe("evm_estimate_transaction_v1");
    const request = call.arguments as EvmEstimateTransactionRequest;
    expect(Object.hasOwn(request, "requestId")).toBe(false);
    calls.push(structuredClone(request));
    return await respond(request) as never;
  } });
  return { wallet, calls };
}

test("both chains estimate exact approval and swap separately and sum wei beyond Number precision", async () => {
  for (const chainId of ["1", "42161"]) {
    const intent = prepared(chainId), before = JSON.stringify(intent), price = 9007199254740993n;
    const { wallet, calls } = client((request) => estimate(request, price));
    const fees = await estimateSwapFees(wallet, intent);
    expect(calls).toEqual([intent.approval!, intent.swap].map((transaction) => ({ accountId: "main" as const, chainId, to: transaction.to.toLowerCase(), data: transaction.data, valueWei: transaction.value })));
    expect(fees.approval?.estimatedFeeWei).toBe((50000n * price).toString());
    expect(fees.swap.estimatedFeeWei).toBe((130000n * price).toString());
    expect(totalEstimatedFee(fees)).toBe((180000n * price).toString());
    expect(fees.swap.postingCosts).toBe(chainId === "42161" ? "included" : "not_applicable");
    expect(JSON.stringify(intent)).toBe(before);
  }
});

test("unavailable swap simulation retains numeric approval and does not manufacture total from Quoter gas", async () => {
  const { wallet } = client((request) => request.to.toLowerCase() !== ROUTER.toLowerCase() ? estimate(request) : {
    ...estimate(request), status: "unavailable", gasLimit: null, estimatedFeeWei: null, maximumFeeWei: null,
    feeBasis: "unavailable", postingCosts: "unavailable", reasons: ["RPC eth_estimateGas reverted: insufficient allowance"],
  });
  const fees = await estimateSwapFees(wallet, prepared());
  expect(fees.approval?.estimatedFeeWei).toBe("150000000000000");
  expect(fees.swap.estimatedFeeWei).toBeNull();
  expect(fees.swap.gasPriceWei).toBe("3000000000");
  expect(fees.swap.reason).toContain("insufficient allowance");
  expect(totalEstimatedFee(fees)).toBeNull();
});

test("native swaps and confirmed approvals estimate only the remaining swap", async () => {
  for (const intent of [prepared("1", false), prepared("42161")]) {
    const { wallet, calls } = client(estimate);
    const fees = await estimateSwapFees(wallet, intent, true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toBe(intent.swap.data);
    expect(calls[0]!.valueWei).toBe(intent.swap.value);
    expect(fees.approval).toBeNull();
    expect(totalEstimatedFee(fees)).toBe(fees.swap.estimatedFeeWei);
  }
});

test("Arbitrum execution-only prices do not become a posting-inclusive total", async () => {
  const { wallet } = client((request) => ({ ...estimate(request), feeBasis: "gas_price", postingCosts: "unavailable" }));
  const fees = await estimateSwapFees(wallet, prepared("42161", false));
  expect(fees.swap.estimatedFeeWei).toBeNull();
  expect(totalEstimatedFee(fees)).toBeNull();
  expect(fees.swap.reason).not.toBeNull();
});

test("approval and swap fee observations start together without waiting for an unrelated read", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const { wallet, calls } = client(async (request) => { if (calls.length === 1) await first; return estimate(request); });
  const result = estimateSwapFees(wallet, prepared());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(2);
  release();
  await result;
  expect(calls).toHaveLength(2);
});

test("provider absence, incompatible results and mismatched scope remain unavailable without effect calls", async () => {
  for (const respond of [
    () => { throw new Error("EVM Wallet provider is not installed."); },
    () => ({ unexpected: true }),
    (request: EvmEstimateTransactionRequest) => ({ ...estimate(request), chainId: "42161" }),
    (request: EvmEstimateTransactionRequest) => ({ ...estimate(request), data: "0xdeadbeef" }),
    (request: EvmEstimateTransactionRequest) => ({ ...estimate(request), address: "0x2222222222222222222222222222222222222222" }),
  ]) {
    const { wallet } = client(respond);
    const fees = await estimateSwapFees(wallet, prepared("1", false));
    expect(fees.swap.estimatedFeeWei).toBeNull();
    expect(fees.swap.reason).not.toBeNull();
    expect(totalEstimatedFee(fees)).toBeNull();
  }
});

test("refresh observes changed fees without altering the quoted minimum, deadline or calldata", async () => {
  let price = 3_000_000_000n;
  const intent = prepared(), frozen = JSON.stringify(intent);
  const { wallet } = client((request) => estimate(request, price));
  const initial = await estimateSwapFees(wallet, intent);
  price = 9_000_000_000n;
  const refreshed = await estimateSwapFees(wallet, intent);
  expect(BigInt(totalEstimatedFee(refreshed)!)).toBe(BigInt(totalEstimatedFee(initial)!) * 3n);
  expect(JSON.stringify(intent)).toBe(frozen);
});

test("old or malformed saved fee annotations render unavailable instead of being treated as zero", async () => {
  const { wallet } = client(estimate), fees = await estimateSwapFees(wallet, prepared());
  expect(readFeeEstimates(undefined)).toBeNull();
  for (const bad of ["1\n", "-1", "1e18", "", 100, undefined]) {
    const changed = { ...fees, swap: { ...fees.swap, estimatedFeeWei: bad } };
    expect(readFeeEstimates(changed)).toBeNull();
    expect(totalEstimatedFee(changed as typeof fees)).toBeNull();
  }
});
