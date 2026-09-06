import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import {
  parseEvmEstimateTransactionRequest,
  parseEvmEstimateTransactionResult,
  parseEvmReplacementTransactionRequest,
  parseEvmReplacementTransactionResult,
} from "neutron-tools/evm_wallet";
import { natural, quantity, record, unwrap } from "./data.ts";

export async function estimateTransaction(
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  const request = parseEvmEstimateTransactionRequest(args);
  const raw = record(unwrap(await context.kernel.updateSelf(
    "evm_wallet_estimate_transaction_v1",
    [{ chain_id: request.chainId, to: request.to, value: request.valueWei, data: request.data }],
    120,
  )), "transaction fee estimate");
  const optional = (field: string) => raw[field] == null ? null : natural(raw[field], field);
  return parseEvmEstimateTransactionResult({
    accountId: request.accountId,
    chainId: natural(raw.chain_id, "estimate chain"),
    address: raw.from,
    to: raw.to,
    valueWei: natural(raw.value, "estimated transaction value"),
    data: raw.data,
    status: raw.status,
    gasLimit: optional("gas_limit"),
    gasPriceWei: optional("gas_price"),
    baseFeePerGasWei: optional("base_fee_per_gas"),
    maxPriorityFeePerGasWei: optional("max_priority_fee_per_gas"),
    maxFeePerGasWei: optional("max_fee_per_gas"),
    estimatedFeeWei: optional("estimated_fee"),
    maximumFeeWei: optional("max_fee"),
    blockNumber: raw.block_number == null ? null : quantity(raw.block_number, "estimate block"),
    observedAtNs: natural(raw.observed_at, "estimate observation time"),
    feeBasis: raw.fee_basis,
    postingCosts: raw.posting_costs,
    reasons: raw.reasons,
    source: "evm_rpc",
  }, request) as unknown as JsonObject;
}

export async function replacementTransaction(
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  const request = parseEvmReplacementTransactionRequest(args);
  const expected = request.originalWalletRequest;
  const raw = record(unwrap(await context.kernel.querySelf(
    "evm_wallet_replacement_transaction_v1",
    [{
      chain_id: request.chainId,
      transaction_hash: request.transactionHash,
      original_wallet_request: {
        caller_app_id: expected.callerAppId,
        caller_installation_uid: expected.callerInstallationUid,
        request_id: expected.requestId,
      },
    }],
  )), "replacement journal proof");
  const original = record(raw.original_wallet_request, "original wallet request");
  return parseEvmReplacementTransactionResult({
    chainId: natural(raw.chain_id, "replacement proof chain"),
    transactionHash: raw.transaction_hash,
    originalWalletRequest: {
      callerAppId: original.caller_app_id,
      callerInstallationUid: natural(original.caller_installation_uid, "original caller installation"),
      requestId: original.request_id,
    },
    walletReplacementMatches: raw.wallet_replacement_matches,
    observedAtNs: natural(raw.observed_at, "replacement proof observation time"),
    source: raw.source,
  }, request) as unknown as JsonObject;
}
