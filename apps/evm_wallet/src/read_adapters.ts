import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import {
  parseEvmBalancesRequest,
  parseEvmCallContractRequest,
  parseEvmReadContractRequest,
  parseEvmEstimateTransactionRequest,
  parseEvmTransactionRequest,
  parseEvmReplacementTransactionRequest,
  parseEvmReplacementTransactionResult,
} from "neutron-tools/evm_wallet";
import { METHODS, natural, record, unwrap, parseSnapshot } from "./data.ts";
import { browserEvmRpc } from "./browser_rpc.ts";
import { browserBalances, browserCallContract, browserReadContract, browserEstimateTransaction, browserTransaction, type BrowserReadRpc } from "./browser_reads.ts";

function rpcFor(context: MsgBusToolContext): BrowserReadRpc {
  return { request: (chainId, method, params, options) => browserEvmRpc.request(chainId, method, params, { ...options, ...(context.signal ? { signal: context.signal } : {}) }) };
}
function readResult(value: unknown, context: MsgBusToolContext): JsonObject {
  // Partial RPC failures can be useful fee/balance evidence, but an explicit
  // caller cancellation must still cancel the complete tool invocation.
  context.signal?.throwIfAborted();
  return value as JsonObject;
}

async function accountSnapshot(context: MsgBusToolContext, accountId: string, chainId: string) {
  const snapshot = parseSnapshot(await context.kernel.querySelf(METHODS.snapshot, [null]));
  const account = snapshot.accounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error("Connect EVM Wallet to initialize its chain-key account first.");
  if (!snapshot.networks.some((network) => network.chainId === chainId)) throw new Error("Unsupported EVM Wallet network");
  return { snapshot, account };
}

export async function balances(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const request = parseEvmBalancesRequest(args), { snapshot, account } = await accountSnapshot(context, request.accountId, request.chainId);
  return readResult(await browserBalances(request, account.address, snapshot.assets, rpcFor(context)), context);
}

export async function readContract(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const request = parseEvmReadContractRequest(args), { account } = await accountSnapshot(context, request.accountId, request.chainId);
  return readResult(await browserReadContract(request, account.address, rpcFor(context)), context);
}

export async function callContract(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const request = parseEvmCallContractRequest(args), { account } = await accountSnapshot(context, request.accountId, request.chainId);
  return readResult(await browserCallContract(request, account.address, rpcFor(context)), context);
}

export async function estimateTransaction(
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  const request = parseEvmEstimateTransactionRequest(args), { account } = await accountSnapshot(context, request.accountId, request.chainId);
  return readResult(await browserEstimateTransaction(request, account.address, rpcFor(context)), context);
}

export async function transaction(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const request = parseEvmTransactionRequest(args);
  let matches: boolean | null = null;
  if (request.walletRequest) {
    const expected = request.walletRequest;
    const raw = unwrap(await context.kernel.querySelf("evm_wallet_transaction_request_matches_v1", [{
      chain_id: request.chainId, transaction_hash: request.transactionHash,
      wallet_request: { caller_app_id: expected.callerAppId, caller_installation_uid: expected.callerInstallationUid, request_id: expected.requestId },
    }]));
    if (typeof raw !== "boolean") throw new Error("Invalid Wallet request journal proof");
    matches = raw;
  }
  return readResult(await browserTransaction(request, matches, rpcFor(context)), context);
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
