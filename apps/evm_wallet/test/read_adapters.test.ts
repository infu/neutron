import { expect, test } from "bun:test";
import type { MsgBusToolContext } from "neutron-tools/app";
import { estimateTransaction, replacementTransaction } from "../src/read_adapters.ts";

const request = { accountId: "main", chainId: "1", to: `0x${"22".repeat(20)}`, valueWei: "7", data: "0x" };
const address = `0x${"11".repeat(20)}`;
function context(result: unknown, calls: Array<{ method: string; args: unknown[] }> = []): MsgBusToolContext {
  return { kernel: { async updateSelf(method: string, args: unknown[]) { calls.push({ method, args }); return result; } } } as unknown as MsgBusToolContext;
}
function available(patch: Record<string, unknown> = {}) {
  const gas = "9007199254740993";
  return {
    chain_id: "1", from: address, to: request.to, value: request.valueWei, data: request.data,
    status: "available", gas_limit: gas, gas_price: "12", base_fee_per_gas: "10",
    max_priority_fee_per_gas: "2", max_fee_per_gas: "22",
    estimated_fee: (BigInt(gas) * 12n).toString(), max_fee: (BigInt(gas) * 22n).toString(),
    block_number: "0x20000000000001", observed_at: "999",
    fee_basis: "base_fee_plus_priority", posting_costs: "not_applicable", reasons: [],
    ...patch,
  };
}
test("fee estimate adapter preserves exact totals and uses only its read endpoint", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const result = await estimateTransaction(request, context(available(), calls));
  expect(calls).toEqual([{ method: "evm_wallet_estimate_transaction_v1", args: [{ chain_id: "1", to: request.to, value: "7", data: "0x" }] }]);
  expect(result).toMatchObject({
    address, accountId: "main", chainId: "1", gasLimit: "9007199254740993", blockNumber: "9007199254740993",
    estimatedFeeWei: "108086391056891916", maximumFeeWei: "198158383604301846", source: "evm_rpc",
  });
});
test("unavailable estimate keeps partial facts and reasons without turning omitted options into zero", async () => {
  const result = await estimateTransaction(request, context({
    chain_id: "1", from: address, to: request.to, value: "7", data: "0x",
    status: "unavailable", base_fee_per_gas: "10", observed_at: "999",
    fee_basis: "unavailable", posting_costs: "not_applicable", reasons: ["Gas estimate unavailable"],
  }));
  expect(result).toMatchObject({ status: "unavailable", gasLimit: null, gasPriceWei: null, blockNumber: null, baseFeePerGasWei: "10", estimatedFeeWei: null, maximumFeeWei: null, reasons: ["Gas estimate unavailable"] });
});
test("Arbitrum total gas includes posting once and mismatched estimate fields are rejected", async () => {
  const arbitrum = { ...request, chainId: "42161" };
  expect(await estimateTransaction(arbitrum, context(available({ chain_id: "42161", fee_basis: "arbitrum_total_gas", posting_costs: "included" })))).toMatchObject({ feeBasis: "arbitrum_total_gas", postingCosts: "included", estimatedFeeWei: "108086391056891916" });
  await expect(estimateTransaction(request, context(available({ value: "8" })))).rejects.toThrow("does not match");
  await expect(estimateTransaction(request, context(available({ estimated_fee: "1" })))).rejects.toThrow("does not match");
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
