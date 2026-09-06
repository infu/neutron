import { querySelf, updateSelf, type JsonValue } from "neutron-tools/app";
import { createEvmRequestId, parseEvmOperationResult, parseEvmSendTransactionRequest, type EvmAccount, type EvmAccountId, type EvmOperationResult, type EvmSendTransactionRequest, type EvmWalletClient, type EvmWalletCaller } from "neutron-tools/evm_wallet";
import { decodeEventLog, getAddress, parseAbi, type Hex } from "viem";
import { prepareSwap, quoteSwap, swapTransaction, type PreparedSwap, type QuoteInput, type Reader, type Transaction } from "./swap.ts";

export type SavedIntent = PreparedSwap & { account: EvmAccount; executionMode: "human" | "agent"; walletCaller: EvmWalletCaller | null };
export type SwapRecord = {
  id: string; account_id: string; chain_id: string; recipient: string; quote_json: string;
  approval_request_id: string | null; approval_request_json: string | null;
  swap_request_id: string; swap_request_json: string;
  approval_operation_json: string | null; swap_operation_json: string | null;
  phase: string; revision: string; created_at: string; updated_at: string;
};
export type Store = { list(): Promise<SwapRecord[]>; get(id: string): Promise<SwapRecord | null>; begin(intent: SavedIntent, id?: string): Promise<SwapRecord>; update(record: SwapRecord, stage: "approval" | "swap", phase: string, operation?: EvmOperationResult | null): Promise<SwapRecord> };
type SelfKernel = { querySelf: typeof querySelf; updateSelf: typeof updateSelf };
export function parseSwapRecord(value: unknown): SwapRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved swap record.");
  const record = value as Record<string, unknown>;
  for (const key of ["id", "account_id", "chain_id", "recipient", "quote_json", "swap_request_id", "swap_request_json", "phase", "revision", "created_at", "updated_at"]) {
    if (typeof record[key] !== "string") throw new Error(`Invalid saved swap ${key}.`);
  }
  const normalized = { ...record };
  for (const key of ["approval_request_id", "approval_request_json", "approval_operation_json", "swap_operation_json"]) {
    if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") throw new Error(`Invalid saved swap ${key}.`);
    normalized[key] = record[key] ?? null;
  }
  return normalized as unknown as SwapRecord;
}
function unwrap(value: JsonValue): SwapRecord {
  // Kernel unwraps successful Candid Result and throws the error arm.
  return parseSwapRecord(value);
}

export function walletRequest(transaction: Transaction, requestId = createEvmRequestId()): EvmSendTransactionRequest {
  return parseEvmSendTransactionRequest({ requestId, accountId: transaction.accountId, chainId: transaction.chainId, to: transaction.to, valueWei: transaction.value, data: transaction.data });
}
export function createSwapStore(kernel: SelfKernel = { querySelf, updateSelf }): Store {
  return {
    async list() {
      const records = await kernel.querySelf("uniswap_list_v1", [null]);
      if (!Array.isArray(records)) throw new Error("Invalid saved swap list.");
      return records.map(parseSwapRecord);
    },
    async get(id) {
      const record = await kernel.querySelf("uniswap_get_v1", [id]);
      return record === null ? null : parseSwapRecord(record);
    },
    async begin(intent, id = createEvmRequestId()) {
      const raw = await kernel.querySelf("uniswap_get_v1", [id]);
      const existing = raw === null ? null : parseSwapRecord(raw);
      if (existing) {
        if (existing.quote_json !== JSON.stringify(intent)) throw new Error("This swap ID already contains a different intent.");
        return existing;
      }
      const approval = intent.approval ? walletRequest(intent.approval) : null;
      const swap = walletRequest(intent.swap);
      return unwrap(await kernel.updateSelf("uniswap_begin_v1", [{ id, account_id: intent.quote.accountId, chain_id: intent.quote.chainId, recipient: intent.quote.recipient, quote_json: JSON.stringify(intent), ...(approval ? { approval_request_id: approval.requestId, approval_request_json: JSON.stringify(approval) } : {}), swap_request_id: swap.requestId, swap_request_json: JSON.stringify(swap) }]));
    },
    async update(record, stage, phase, operation = null) {
      const requestId = stage === "approval" ? record.approval_request_id : record.swap_request_id;
      if (!requestId) throw new Error("This swap has no approval step.");
      if (operation) validateOperation(record, stage, operation);
      return unwrap(await kernel.updateSelf("uniswap_update_v1", [{ id: record.id, expected_revision: record.revision, stage, request_id: requestId, account_id: record.account_id, chain_id: record.chain_id, ...(operation ? { operation_json: JSON.stringify(operation) } : {}), phase }]));
    },
  };
}
export function walletReader(wallet: EvmWalletClient, accountId: EvmAccountId): Reader {
  return async (chainId, to, data, blockTag) => {
    const response = await wallet.readContract({ accountId, chainId, to, data });
    if (blockTag && BigInt(blockTag).toString() !== response.blockNumber) throw new Error("Pool state and quote were observed in different blocks; price impact is unavailable.");
    return { data: response.result as Hex, blockNumber: response.blockNumber, observedAtMs: Number(BigInt(response.observedAtNs) / 1_000_000n) };
  };
}
export async function createIntent(wallet: EvmWalletClient, input: QuoteInput): Promise<SavedIntent> {
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === input.accountId);
  if (!account || account.address.toLowerCase() !== input.accountAddress.toLowerCase()) throw new Error("The selected EVM Wallet account changed. Reconnect and quote again.");
  const read = walletReader(wallet, account.accountId);
  const quote = await quoteSwap(read, input);
  return { ...await prepareSwap(read, quote), account, executionMode: "human", walletCaller: null };
}
export function savedIntent(record: SwapRecord): SavedIntent {
  const intent = JSON.parse(record.quote_json) as SavedIntent;
  if (intent.quote.chainId !== record.chain_id || intent.quote.accountId !== record.account_id || intent.quote.recipient.toLowerCase() !== record.recipient.toLowerCase()) throw new Error("Saved swap identity does not match its journal.");
  // Rebuild immutable calldata even after expiry. Expiry is checked again before any new request.
  const rebuilt = swapTransaction(intent.quote, 0);
  const request = parseEvmSendTransactionRequest(JSON.parse(record.swap_request_json));
  if (request.requestId !== record.swap_request_id || request.data !== rebuilt.data || request.to.toLowerCase() !== rebuilt.to.toLowerCase() || request.valueWei !== rebuilt.value || request.chainId !== rebuilt.chainId || request.accountId !== rebuilt.accountId) throw new Error("Saved swap transaction does not match its quote.");
  return intent;
}
export function validateOperation(record: SwapRecord, stage: "approval" | "swap", raw: unknown): EvmOperationResult {
  const operation = parseEvmOperationResult(raw);
  const intent = savedIntent(record);
  const requestId = stage === "approval" ? record.approval_request_id : record.swap_request_id;
  if (operation.requestId !== requestId || operation.accountId !== record.account_id || operation.chainId !== record.chain_id || operation.address.toLowerCase() !== intent.account.address.toLowerCase() || operation.kind !== "transaction") throw new Error("Wallet operation does not match the saved swap request.");
  return operation;
}
export async function checkAccount(wallet: EvmWalletClient, intent: SavedIntent): Promise<void> {
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === intent.account.accountId);
  if (!account || account.address.toLowerCase() !== intent.account.address.toLowerCase() || account.keyFingerprint !== intent.account.keyFingerprint || account.namespaceVersion !== intent.account.namespaceVersion) throw new Error("EVM Wallet signing identity changed. This saved request cannot be replayed with a replacement account.");
}
export function approvalConfirmed(record: SwapRecord): boolean {
  if (record.approval_request_id === null) return true;
  if (record.approval_operation_json === null) return false;
  const operation = validateOperation(record, "approval", JSON.parse(record.approval_operation_json));
  return operation.status === "confirmed" && operation.receipt?.status === "success";
}
export async function reconcileStep(wallet: EvmWalletClient, store: Store, record: SwapRecord, stage: "approval" | "swap"): Promise<SwapRecord> {
  const requestId = stage === "approval" ? record.approval_request_id : record.swap_request_id;
  if (!requestId) return record;
  await checkAccount(wallet, savedIntent(record));
  const result = await wallet.operationStatus({ accountId: record.account_id as EvmAccountId, chainId: record.chain_id, requestId });
  if (result.status === "not_found") return record;
  validateOperation(record, stage, result);
  return store.update(record, stage, `${stage}_${result.status}`, result);
}
export async function executeStep(wallet: EvmWalletClient, store: Store, record: SwapRecord, stage: "approval" | "swap"): Promise<SwapRecord> {
  const intent = savedIntent(record);
  if (intent.executionMode !== "human") throw new Error("This swap belongs to an Agent workflow. The root agent must call EVM Wallet directly.");
  await checkAccount(wallet, intent);
  record = await reconcileStep(wallet, store, record, stage);
  const recorded = stage === "approval" ? record.approval_operation_json : record.swap_operation_json;
  if (recorded) {
    const operation = validateOperation(record, stage, JSON.parse(recorded));
    if (!["preparing", "prepared"].includes(operation.status)) return record;
  }
  if (stage === "swap" && !approvalConfirmed(record)) throw new Error("Wait for the approval receipt before requesting the swap.");
  // Frozen deadline/calldata are retained on retry. Never silently refresh a submitted swap.
  swapTransaction(intent.quote);
  const requestJson = stage === "approval" ? record.approval_request_json : record.swap_request_json;
  if (!requestJson) throw new Error("No approval is needed.");
  const request = parseEvmSendTransactionRequest(JSON.parse(requestJson));
  if (stage === "approval" && intent.approval) {
    const expected = walletRequest(intent.approval, request.requestId);
    if (JSON.stringify(request) !== JSON.stringify(expected)) throw new Error("Saved approval does not match the exact quoted amount and spender.");
  }
  record = await store.update(record, stage, `${stage}_requested`);
  // A lost reply leaves requested state. Reload reconciles this same request ID first.
  const operation = await wallet.sendTransaction(request);
  validateOperation(record, stage, operation);
  return store.update(record, stage, `${stage}_${operation.status}`, operation);
}
const TRANSFER_ABI = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
export function receivedTokenAtoms(record: SwapRecord): string | null {
  const intent = savedIntent(record);
  if (!record.swap_operation_json || intent.quote.tokenOut.address === null) return null;
  const operation = validateOperation(record, "swap", JSON.parse(record.swap_operation_json));
  if (operation.receipt?.status !== "success") return null;
  let total = 0n;
  for (const log of operation.receipt.logs) {
    if (log.address.toLowerCase() !== intent.quote.tokenOut.address.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: TRANSFER_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      if (getAddress(event.args.to) === getAddress(intent.quote.recipient)) total += event.args.value;
    } catch { /* Only output-token Transfer logs addressed to the requested recipient count. */ }
  }
  return total.toString();
}

/** Agent-returned data is a hint until independently read from public chain state. */
export async function verifyAgentResult(wallet: EvmWalletClient, store: Store, record: SwapRecord, stage: "approval" | "swap", claimed: unknown): Promise<SwapRecord> {
  const operation = validateOperation(record, stage, claimed);
  const intent = savedIntent(record);
  if (intent.executionMode !== "agent") throw new Error("This is not an Agent swap.");
  await checkAccount(wallet, intent);
  if (!operation.transactionHash) throw new Error("No transaction hash is available to independently verify. The operation remains unresolved.");
  const requestJson = stage === "approval" ? record.approval_request_json : record.swap_request_json;
  if (!requestJson) throw new Error("This swap has no approval step.");
  const request = parseEvmSendTransactionRequest(JSON.parse(requestJson));
  if (!intent.walletCaller) throw new Error("Saved Agent caller identity is unavailable. Keep this operation unresolved; do not invent an origin or repeat an effect.");
  const evidence = await wallet.transaction({ chainId: record.chain_id, transactionHash: operation.transactionHash, walletRequest: { callerAppId: intent.walletCaller.appId, callerInstallationUid: intent.walletCaller.installationUid, requestId: request.requestId } });
  if (evidence.walletRequestMatches !== true) throw new Error("EVM Wallet did not bind this transaction hash to the exact saved caller and request ID.");
  if (!evidence.transaction) throw new Error("Transaction is not yet visible through EVM RPC. Keep the same request ID and check again.");
  const actual = evidence.transaction;
  if (actual.from.toLowerCase() !== intent.account.address.toLowerCase() || actual.to?.toLowerCase() !== request.to.toLowerCase() || actual.data.toLowerCase() !== request.data.toLowerCase() || actual.valueWei !== request.valueWei) throw new Error("On-chain transaction does not match the saved swap request.");
  const verified: EvmOperationResult = { ...operation, receipt: evidence.receipt, signature: null, status: evidence.receipt ? evidence.receipt.status === "success" ? "confirmed" : "reverted" : "submitted", message: "EVM Wallet confirmed the exact caller/request binding; transaction fields and receipt were read independently through EVM RPC." };
  return store.update(record, stage, `${stage}_${verified.status}`, verified);
}
