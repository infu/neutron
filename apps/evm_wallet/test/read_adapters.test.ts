import { afterEach, expect, spyOn, test } from "bun:test";
import type { MsgBusToolContext } from "neutron-tools/app";
import { balances, callContract, readContract, estimateTransaction, transaction, replacementTransaction } from "../src/read_adapters.ts";
import { BrowserEvmRpcError, browserEvmRpc } from "../src/browser_rpc.ts";

const request = { accountId: "main", chainId: "1", to: `0x${"22".repeat(20)}`, valueWei: "7", data: "0x" };
const address = `0x${"11".repeat(20)}`;
const txHash = `0x${"33".repeat(32)}`, blockHash = `0x${"44".repeat(32)}`;
const uintWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function rpcFixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ chain: string; method: string; params: readonly unknown[]; signal?: AbortSignal }> = [];
  const replies: Record<string, unknown> = {
    eth_blockNumber: "0x55", eth_getBalance: "0x20000000000001", eth_call: uintWord(7n), eth_getCode: "0x6000",
    eth_getBlockByNumber: { number: "0x55", hash: blockHash, baseFeePerGas: "0xa" },
    eth_gasPrice: "0xc", eth_maxPriorityFeePerGas: "0x2", eth_estimateGas: "0x20000000000001",
    eth_getTransactionByHash: null, eth_getTransactionReceipt: null, ...overrides,
  };
  const spy = spyOn(browserEvmRpc, "request").mockImplementation(async (chain, method, params = [], options = {}) => {
    calls.push({ chain: String(chain), method, params, ...(options.signal ? { signal: options.signal } : {}) });
    const result = replies[method];
    if (result instanceof Error) throw result;
    if (typeof result === "function") return result(params);
    if (!Object.hasOwn(replies, method)) throw new Error(`Unexpected RPC ${method}`);
    return result;
  });
  restore = () => spy.mockRestore();
  return { calls, replies };
}
function context(chain = "1", matches: unknown = false) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const snapshot = {
    accounts: [{ id: "main", slot: "main", address, public_key: new Uint8Array([2, ...new Uint8Array(32)]), namespace_version: "1" }],
    networks: [{ chain_id: chain, name: "Test network", native_symbol: "ETH", explorer_url: "https://example.test", testnet: true, finality_description: "Test finality" }],
    assets: [{ chain_id: chain, address: request.to, symbol: "USDC", decimals: "6" }], lifecycle: "active",
  };
  const ctx = { kernel: {
    async querySelf(method: string, args: unknown[]) {
      calls.push({ method, args });
      if (method === "evm_wallet_snapshot_v1") return snapshot;
      if (method === "evm_wallet_transaction_request_matches_v1") return matches;
      throw new Error(`Unexpected backend query ${method}`);
    },
    async updateSelf() { throw new Error("Read attempted backend update/RPC"); },
  } } as unknown as MsgBusToolContext;
  return { ctx, calls, snapshot };
}

test("lightweight contract read pins its block without backend update or code download", async () => {
  const rpc = rpcFixture(), { ctx, calls } = context("42161");
  const controller = new AbortController(); ctx.signal = controller.signal;
  const input = { accountId: "main", chainId: "42161", to: request.to, data: "0x1234", blockTag: "9007199254740993" };
  expect(await callContract(input, ctx)).toMatchObject({ accountId: "main", chainId: "42161", address, result: uintWord(7n), blockNumber: "9007199254740993" });
  expect(rpc.calls).toEqual([{ chain: "42161", method: "eth_call", params: [{ from: address, to: request.to, data: "0x1234" }, "0x20000000000001"], signal: controller.signal }]);
  expect(calls).toEqual([{ method: "evm_wallet_snapshot_v1", args: [null] }]);
});

test("compatibility contract read retains code at the exact call block", async () => {
  const rpc = rpcFixture();
  expect(await readContract({ accountId: "main", chainId: "1", to: request.to, data: "0x" }, context().ctx)).toMatchObject({ code: "0x6000", result: uintWord(7n), blockNumber: "85" });
  expect(rpc.calls.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "eth_blockNumber", params: [] },
    { method: "eth_call", params: [{ from: address, to: request.to, data: "0x" }, "0x55"] },
    { method: "eth_getCode", params: [request.to, "0x55"] },
  ]);
});

test("a missing latest code header restarts the whole observation without mixing blocks", async () => {
  let heads = 0;
  const rpc = rpcFixture({
    eth_blockNumber: () => ++heads === 1 ? "0x55" : "0x56",
    eth_call: (params: unknown[]) => uintWord(params[1] === "0x55" ? 7n : 8n),
    eth_getCode: (params: unknown[]) => {
      if (params[1] === "0x55") throw new BrowserEvmRpcError("RPC eth_getCode on chain 1: header not found", -32000);
      return "0x6001";
    },
  });
  expect(await readContract({ accountId: "main", chainId: "1", to: request.to, data: "0x" }, context().ctx))
    .toMatchObject({ code: "0x6001", result: uintWord(8n), blockNumber: "86" });
  expect(rpc.calls.map(({ method, params }) => [method, params[1]])).toEqual([
    ["eth_blockNumber", undefined], ["eth_call", "0x55"], ["eth_getCode", "0x55"],
    ["eth_blockNumber", undefined], ["eth_call", "0x56"], ["eth_getCode", "0x56"],
  ]);
});

test("a latest contract call can refresh an unavailable head but an explicit block stays pinned", async () => {
  let firstCall = true;
  const rpc = rpcFixture({ eth_call: () => {
    if (firstCall) { firstCall = false; throw new BrowserEvmRpcError("RPC eth_call on chain 1: header not found", -32000); }
    return uintWord(9n);
  } });
  const input = { accountId: "main", chainId: "1", to: request.to, data: "0x", blockTag: "latest" };
  expect(await callContract(input, context().ctx)).toMatchObject({ result: uintWord(9n), blockNumber: "85" });
  expect(rpc.calls.map(({ method }) => method)).toEqual(["eth_blockNumber", "eth_call", "eth_blockNumber", "eth_call"]);

  firstCall = true;
  rpc.calls.length = 0;
  await expect(callContract({ ...input, blockTag: "85" }, context().ctx)).rejects.toThrow("header not found");
  expect(rpc.calls.map(({ method, params }) => [method, params[1]])).toEqual([["eth_call", "0x55"]]);
});

test("contract read recovery does not retry reverts or loop on unavailable headers", async () => {
  const rpc = rpcFixture({ eth_call: new BrowserEvmRpcError("RPC eth_call on chain 1: execution reverted", -32000) });
  const input = { accountId: "main", chainId: "1", to: request.to, data: "0x" };
  await expect(readContract(input, context().ctx)).rejects.toThrow("execution reverted");
  expect(rpc.calls.map(({ method }) => method)).toEqual(["eth_blockNumber", "eth_call"]);

  rpc.calls.length = 0;
  rpc.replies.eth_call = uintWord(7n);
  rpc.replies.eth_getCode = new BrowserEvmRpcError("RPC eth_getCode on chain 1: header not found", -32000);
  await expect(readContract(input, context().ctx)).rejects.toThrow("header not found");
  expect(rpc.calls.map(({ method }) => method)).toEqual([
    "eth_blockNumber", "eth_call", "eth_getCode", "eth_blockNumber", "eth_call", "eth_getCode",
  ]);
});

test("balances keep one block, selected metadata and independent token failures", async () => {
  const other = `0x${"66".repeat(20)}`;
  const rpc = rpcFixture({ eth_call: (params: unknown[]) => (params[0] as { to: string }).to === other ? "0x01" : uintWord(20_000_000n) });
  expect(await balances({ accountId: "main", chainId: "1", tokens: [request.to, other] }, context().ctx)).toMatchObject({
    nativeBalanceWei: "9007199254740993", blockNumber: "85", completeness: "requested_only",
    tokens: [{ address: request.to, balanceAtoms: "20000000", decimals: "6", symbol: "USDC", error: null },
      { address: other, balanceAtoms: null, decimals: null, symbol: null, error: "ERC20 balanceOf returned an invalid uint256 word" }],
  });
  expect(rpc.calls.filter(({ method }) => method !== "eth_blockNumber").every(({ params, chain }) => params[1] === "0x55" && chain === "1")).toBe(true);
});

test("browser fee estimates preserve exact totals and pin simulation", async () => {
  const rpc = rpcFixture(), { ctx, calls } = context();
  expect(await estimateTransaction(request, ctx)).toMatchObject({ address, gasLimit: "9007199254740993", blockNumber: "85",
    estimatedFeeWei: "108086391056891916", maximumFeeWei: "198158383604301846", source: "evm_rpc" });
  expect(rpc.calls.find(({ method }) => method === "eth_estimateGas")?.params).toEqual([{ from: address, to: request.to, value: "0x7", data: "0x" }, "0x55"]);
  expect(calls).toEqual([{ method: "evm_wallet_snapshot_v1", args: [null] }]);
});

test("failed simulation retains fee observations without invented zero gas", async () => {
  rpcFixture({ eth_estimateGas: new Error("execution reverted: allowance") });
  expect(await estimateTransaction(request, context().ctx)).toMatchObject({ status: "unavailable", gasLimit: null, baseFeePerGasWei: "10", gasPriceWei: "12", maxPriorityFeePerGasWei: "2", estimatedFeeWei: null, maximumFeeWei: null,
    reasons: ["eth_estimateGas: execution reverted: allowance"] });
});

test("missing block and pricing retain partials without claiming a pinned observation", async () => {
  const rpc = rpcFixture({ eth_getBlockByNumber: new Error("block unavailable"), eth_gasPrice: new Error("price unavailable"), eth_maxPriorityFeePerGas: new Error("tip unavailable") });
  expect(await estimateTransaction(request, context().ctx)).toMatchObject({ status: "unavailable", gasLimit: "9007199254740993", blockNumber: null, baseFeePerGasWei: null, estimatedFeeWei: null });
  expect(rpc.calls.find(({ method }) => method === "eth_estimateGas")?.params[1]).toBe("latest");
});

test("explicit cancellation is not returned as an unavailable fee estimate", async () => {
  const fixture = rpcFixture(), { ctx } = context(), controller = new AbortController();
  ctx.signal = controller.signal;
  fixture.replies.eth_estimateGas = () => {
    controller.abort(new Error("Owner cancelled quote"));
    throw controller.signal.reason;
  };
  await expect(estimateTransaction(request, ctx)).rejects.toThrow("Owner cancelled quote");
});

test("Arbitrum uses total gas once and does not request a priority tip", async () => {
  const rpc = rpcFixture();
  expect(await estimateTransaction({ ...request, chainId: "42161" }, context("42161").ctx)).toMatchObject({ feeBasis: "arbitrum_total_gas", postingCosts: "included", maxPriorityFeePerGasWei: "0", estimatedFeeWei: "108086391056891916" });
  expect(rpc.calls.every(({ chain, method }) => chain === "42161" && method !== "eth_maxPriorityFeePerGas")).toBe(true);
});

function minedTransaction() { return { hash: txHash, chainId: "0x1", from: address, to: request.to, input: "0x", value: "0x7", nonce: "0x9", blockNumber: "0x55", blockHash }; }
function minedReceipt() { return { transactionHash: txHash, blockNumber: "0x55", blockHash, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0xc", logs: [] }; }

test("public chain evidence gets request binding independently from the Wallet journal", async () => {
  const rpc = rpcFixture({ eth_getTransactionByHash: minedTransaction(), eth_getTransactionReceipt: minedReceipt() });
  const { ctx, calls } = context("1", false);
  const walletRequest = { callerAppId: "uniswap", callerInstallationUid: "99", requestId: "ab".repeat(16) };
  expect(await transaction({ chainId: "1", transactionHash: txHash, walletRequest }, ctx)).toMatchObject({ walletRequestMatches: false,
    transaction: { from: address, valueWei: "7", nonce: "9", blockNumber: "85" }, receipt: { status: "success", finality: "finalized", blockHash }, source: "evm_rpc" });
  expect(calls).toEqual([{ method: "evm_wallet_transaction_request_matches_v1", args: [{ chain_id: "1", transaction_hash: txHash,
    wallet_request: { caller_app_id: "uniswap", caller_installation_uid: "99", request_id: walletRequest.requestId } }] }]);
  expect(rpc.calls.every(({ chain }) => chain === "1")).toBe(true);
});

test("absent transactions need no backend query without a request proof", async () => {
  rpcFixture(); const { ctx, calls } = context();
  expect(await transaction({ chainId: "1", transactionHash: txHash }, ctx)).toMatchObject({ transaction: null, receipt: null, walletRequestMatches: null });
  expect(calls).toEqual([]);
});

test("reorganized receipt blocks and wrong transaction chain/hash are rejected", async () => {
  const rpc = rpcFixture({ eth_getTransactionByHash: minedTransaction(), eth_getTransactionReceipt: minedReceipt(), eth_getBlockByNumber: { number: "0x55", hash: `0x${"ff".repeat(32)}` } });
  await expect(transaction({ chainId: "1", transactionHash: txHash }, context().ctx)).rejects.toThrow("canonical receipt block hash");
  rpc.replies.eth_getTransactionByHash = { ...minedTransaction(), chainId: "0xa4b1" };
  await expect(transaction({ chainId: "1", transactionHash: txHash }, context().ctx)).rejects.toThrow("transaction chain");
  rpc.replies.eth_getTransactionByHash = { ...minedTransaction(), hash: `0x${"ff".repeat(32)}` };
  await expect(transaction({ chainId: "1", transactionHash: txHash }, context().ctx)).rejects.toThrow("transaction hash");
});

test("missing accounts and unsupported Wallet networks stop before browser RPC", async () => {
  const rpc = rpcFixture(), fixture = context(); fixture.snapshot.accounts = [];
  await expect(callContract({ accountId: "main", chainId: "1", to: request.to, data: "0x" }, fixture.ctx)).rejects.toThrow("initialize");
  await expect(callContract({ accountId: "main", chainId: "42161", to: request.to, data: "0x" }, context().ctx)).rejects.toThrow("Unsupported");
  expect(rpc.calls).toEqual([]);
});

test("replacement proof is a read-only journal lookup bound to the exact original request", async () => {
  const originalWalletRequest = { callerAppId: "wallet", callerInstallationUid: "9007199254740993", requestId: "ab".repeat(16) };
  const query = { chainId: "1", transactionHash: `0x${"33".repeat(32)}`, originalWalletRequest };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const wire = { chain_id: "1", transaction_hash: query.transactionHash, original_wallet_request: { caller_app_id: "wallet", caller_installation_uid: "9007199254740993", request_id: originalWalletRequest.requestId }, wallet_replacement_matches: false, observed_at: "999", source: "evm_wallet_journal" };
  const ctx = { kernel: { async querySelf(method: string, args: unknown[]) { calls.push({ method, args }); return wire; }, async updateSelf() { throw new Error("Proof lookup attempted mutation"); } } } as unknown as MsgBusToolContext;
  expect(await replacementTransaction(query, ctx)).toEqual({ ...query, walletReplacementMatches: false, observedAtNs: "999", source: "evm_wallet_journal" });
  expect(calls).toEqual([{ method: "evm_wallet_replacement_transaction_v1", args: [{ chain_id: "1", transaction_hash: query.transactionHash, original_wallet_request: wire.original_wallet_request }] }]);
  wire.wallet_replacement_matches = true;
  expect((await replacementTransaction(query, ctx)).walletReplacementMatches).toBe(true);
  wire.original_wallet_request.request_id = "cd".repeat(16);
  await expect(replacementTransaction(query, ctx)).rejects.toThrow("does not match");
});
