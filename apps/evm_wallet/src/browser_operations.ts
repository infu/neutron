import type { MsgBusToolContext, SelfCallObject } from "neutron-tools/app";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import { browserEvmRpc, BrowserEvmRpcError } from "./browser_rpc.ts";
import { automaticGasLimit } from "./gas.ts";
import { METHODS, identityArgs, parseAccounts, parseOperation, parseReviewEvidence, record, unwrap, errorMessage, type Operation } from "./data.ts";

/** Only the installed Wallet supplies observations. The backend owns the exact
 * intent, candidate nonce, approval revision, signature and retained raw bytes. */
export type OperationKernel = Pick<MsgBusToolContext["kernel"], "querySelf" | "updateSelf">;
export type OperationOptions = { signal?: AbortSignal | undefined };
const decimal = (value: unknown): string => {
  if (typeof value !== "string" || !/^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(value)) throw new Error("RPC returned an invalid quantity");
  return BigInt(value).toString();
};
const quantity = (value: string) => `0x${BigInt(value).toString(16)}`;
const identityOf = (operation: Operation) => identityArgs(operation.caller, operation.requestId);
const rpc = <T = unknown>(chain: string, method: string, params: unknown[], options: OperationOptions): Promise<T> => browserEvmRpc.request<T>(chain, method, params, options);
const observationJson = (value: Record<string, unknown> | null, fields: readonly string[]): string =>
  JSON.stringify(value === null ? null : Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])));

export async function readBrowserOperation(kernel: OperationKernel, identity: SelfCallObject): Promise<Operation | null> {
  try { return parseOperation(await kernel.querySelf("evm_wallet_operation_v1", [{ identity }])); }
  catch (error) { if (errorMessage(error) === "not_found") return null; throw error; }
}

export function candidateCall(operation: Operation, gas?: string): Record<string, unknown> {
  const tx = operation.preparedTransaction;
  if (!tx || tx.chainId !== operation.chainId) throw new Error("Wallet has no exact transaction candidate");
  return {
    from: operation.address, to: tx.to, value: quantity(tx.value), data: tx.data,
    nonce: quantity(tx.nonce), accessList: tx.accessList,
    ...(gas === undefined ? {} : { gas: quantity(gas) }),
    ...(tx.gasPrice === null ? {} : { gasPrice: quantity(tx.gasPrice) }),
    ...(tx.maxFeePerGas === null ? {} : { maxFeePerGas: quantity(tx.maxFeePerGas) }),
    ...(tx.maxPriorityFeePerGas === null ? {} : { maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas) }),
  };
}

export async function prepareBrowserOperation(kernel: OperationKernel, identity: SelfCallObject, intent: SelfCallObject, options: OperationOptions = {}): Promise<Operation> {
  options.signal?.throwIfAborted();
  const existing = await readBrowserOperation(kernel, identity);
  // Every repeat still visits the backend's exact intent-conflict check below.
  const chain = String(intent.chain_id);
  const request = { identity, intent };
  const operationIntent = intent.operation as SelfCallObject;
  const isTransaction = !!(operationIntent.transaction || operationIntent.replacement);
  const emptyObservation = { block_number: "0", balance: "0", pending_nonce: "0", mined_nonce: "0", gas_price: "0", max_priority_fee_per_gas: "0", base_fee_per_gas: "0" };
  // A preparing transaction needs real observations before the backend can
  // refresh its unsigned candidate. Zero observations are only used when no
  // transaction construction is needed; they must not replace live fees.
  if (!isTransaction || (existing && existing.status !== "preparing")) {
    const retained = parseOperation(await kernel.updateSelf("evm_wallet_prepare_browser_v1", [{ request, observation: emptyObservation }], 120));
    if (retained.status !== "preparing" || !isTransaction) return retained;
  }
  const accounts = parseAccounts(await kernel.updateSelf(METHODS.accounts, [null], 120));
  const account = accounts.find((value) => value.id === intent.account_id);
  if (!account) throw new Error("EVM Wallet account unavailable");
  const [block, pending, gasPrice, priority] = await Promise.all([
    rpc<Record<string, unknown>>(chain, "eth_getBlockByNumber", ["latest", false], options),
    rpc<string>(chain, "eth_getTransactionCount", [account.address, "pending"], options),
    rpc<string>(chain, "eth_gasPrice", [], options),
    chain === "42161" ? Promise.resolve("0x0") : rpc<string>(chain, "eth_maxPriorityFeePerGas", [], options),
  ]);
  const blockNumber = quantity(decimal(block.number));
  const [balance, mined] = await Promise.all([
    rpc<string>(chain, "eth_getBalance", [account.address, blockNumber], options),
    rpc<string>(chain, "eth_getTransactionCount", [account.address, blockNumber], options),
  ]);
  options.signal?.throwIfAborted();
  const operation = parseOperation(await kernel.updateSelf("evm_wallet_prepare_browser_v1", [{ request, observation: {
    block_number: blockNumber, balance: decimal(balance), pending_nonce: decimal(pending), mined_nonce: decimal(mined),
    gas_price: decimal(gasPrice), max_priority_fee_per_gas: decimal(priority), base_fee_per_gas: decimal(block.baseFeePerGas ?? "0x0"),
  } }], 120));
  return finishBrowserCandidate(kernel, operation, blockNumber, decimal(balance), options);
}

async function finishBrowserCandidate(kernel: OperationKernel, candidate: Operation, blockNumber: string, balance: string, options: OperationOptions): Promise<Operation> {
  let operation = candidate;
  while (operation.status === "preparing") {
    options.signal?.throwIfAborted();
    let stage = "gas estimation";
    try {
      const estimate = decimal(await rpc<string>(operation.chainId, "eth_estimateGas", [candidateCall(operation), blockNumber], options));
      const explicit = operation.intent.transaction?.gasLimit;
      const gas = explicit ?? automaticGasLimit(BigInt(estimate)).toString();
      if (BigInt(gas) < BigInt(estimate)) throw new Error("Requested gas limit is below the live estimate");
      stage = "simulation";
      const simulation = await rpc<string>(operation.chainId, "eth_call", [candidateCall(operation, gas), blockNumber], options);
      stage = "nonce observation";
      const [pending, mined] = await Promise.all([
        rpc<string>(operation.chainId, "eth_getTransactionCount", [operation.address, "pending"], options),
        rpc<string>(operation.chainId, "eth_getTransactionCount", [operation.address, blockNumber], options),
      ]);
      options.signal?.throwIfAborted();
      stage = "saving the simulation";
      operation = parseOperation(await kernel.updateSelf("evm_wallet_finish_prepare_browser_v1", [{ identity: identityOf(operation), review_revision: operation.reviewRevision, balance, pending_nonce: decimal(pending), mined_nonce: decimal(mined), gas_estimate: estimate, gas_limit: gas, simulation }], 120));
    } catch (error) {
      options.signal?.throwIfAborted();
      const rpcData = error instanceof BrowserEvmRpcError && error.data !== undefined
        ? `; RPC data: ${JSON.stringify(error.data)}` : "";
      // This only records diagnostics for this unsigned review revision. The
      // backend returns any newer saved state without overwriting it. A failed
      // observation never becomes a signature, broadcast, or automatic retry.
      return parseOperation(await kernel.updateSelf("evm_wallet_preparation_error_browser_v1", [{
        identity: identityOf(operation), review_revision: operation.reviewRevision,
        block_number: decimal(blockNumber), stage, message: `${errorMessage(error)}${rpcData}`,
      }], 120));
    }
  }
  return operation;
}

async function observeOperation(kernel: OperationKernel, operation: Operation, options: OperationOptions, broadcastError?: string): Promise<Operation> {
  const hash = operation.transactionHash;
  if (!hash) return operation;
  const [transaction, receipt] = await Promise.all([
    rpc<Record<string, unknown> | null>(operation.chainId, "eth_getTransactionByHash", [hash], options),
    rpc<Record<string, unknown> | null>(operation.chainId, "eth_getTransactionReceipt", [hash], options),
  ]);
  let canonical: Record<string, unknown> | null = null;
  let safe: Record<string, unknown> | null = null;
  let finalized: Record<string, unknown> | null = null;
  if (receipt) {
    const observations = await Promise.allSettled([
      rpc<Record<string, unknown> | null>(operation.chainId, "eth_getBlockByNumber", [receipt.blockNumber, false], options),
      rpc<Record<string, unknown> | null>(operation.chainId, "eth_getBlockByNumber", ["safe", false], options),
      rpc<Record<string, unknown> | null>(operation.chainId, "eth_getBlockByNumber", ["finalized", false], options),
    ]);
    if (observations[0].status === "rejected") throw observations[0].reason;
    canonical = observations[0].value;
    if (observations[1].status === "fulfilled") safe = observations[1].value;
    if (observations[2].status === "fulfilled") finalized = observations[2].value;
  }
  options.signal?.throwIfAborted();
  // Even getBlockByNumber(..., false) includes every transaction hash in the
  // block. Three busy blocks can exceed the self-call metadata boundary. Keep
  // the headers used for canonicality/finality and the transaction fields the
  // backend validates. The receipt keeps every log, including its full data.
  return parseOperation(await kernel.updateSelf("evm_wallet_observe_browser_v1", [{
    identity: identityOf(operation), transaction_hash: hash,
    transaction_json: observationJson(transaction, ["hash", "chainId", "nonce", "value", "gas", "from", "to", "input", "data"]),
    ...(receipt ? { receipt_json: observationJson(receipt, ["transactionHash", "blockNumber", "blockHash", "status", "gasUsed", "effectiveGasPrice", "logs"]) } : {}),
    ...(canonical ? { canonical_block_json: observationJson(canonical, ["number", "hash"]) } : {}),
    ...(safe ? { safe_block_json: observationJson(safe, ["number", "hash"]) } : {}),
    ...(finalized ? { finalized_block_json: observationJson(finalized, ["number", "hash"]) } : {}),
    ...(broadcastError ? { broadcast_error: broadcastError } : {}),
  }], 120));
}

async function broadcastSaved(kernel: OperationKernel, operation: Operation, options: OperationOptions): Promise<Operation> {
  const submission = record(unwrap(await kernel.querySelf("evm_wallet_submission_v1", [{ identity: identityOf(operation) }])), "signed transaction");
  if (String(submission.chain_id) !== operation.chainId || submission.transaction_hash !== operation.transactionHash || typeof submission.raw_transaction !== "string" || keccak256(submission.raw_transaction as Hex) !== operation.transactionHash) throw new Error("Saved signed transaction does not match this operation");
  options.signal?.throwIfAborted();
  let error: string | undefined;
  try {
    const hash = await rpc<string>(operation.chainId, "eth_sendRawTransaction", [submission.raw_transaction], options);
    if (typeof hash !== "string" || hash.toLowerCase() !== operation.transactionHash?.toLowerCase()) error = "RPC returned a different transaction hash";
  } catch (cause) { error = `Broadcast outcome requires reconciliation: ${errorMessage(cause)}`; }
  // A lost POST response never causes another signature or an automatic retry.
  // The durable signed bytes remain recoverable even if this observation fails.
  return observeOperation(kernel, operation, options, error);
}

export async function executeBrowserOperation(kernel: OperationKernel, operation: Operation, options: OperationOptions = {}): Promise<Operation> {
  options.signal?.throwIfAborted();
  const result = parseOperation(await kernel.updateSelf(METHODS.execute, [{ identity: identityOf(operation), review_revision: operation.reviewRevision }], 120));
  if (result.requestId !== operation.requestId || result.operationId !== operation.operationId || result.chainId !== operation.chainId || result.accountId !== operation.accountId || result.address.toLowerCase() !== operation.address.toLowerCase() || JSON.stringify(identityOf(result)) !== JSON.stringify(identityOf(operation)) || JSON.stringify(result.intent) !== JSON.stringify(operation.intent)) throw new Error("Wallet execution returned a different operation");
  if (result.status === "signed" && (result.reviewRevision !== operation.reviewRevision || JSON.stringify(result.preparedTransaction) !== JSON.stringify(operation.preparedTransaction))) throw new Error("Signed transaction differs from the approved review");
  if (result.status === "preparing") {
    const block = await rpc<Record<string, unknown>>(result.chainId, "eth_getBlockByNumber", ["latest", false], options);
    const blockNumber = quantity(decimal(block.number));
    const balance = decimal(await rpc<string>(result.chainId, "eth_getBalance", [result.address, blockNumber], options));
    // A changed nonce requires fresh simulation and a new visible approval.
    // Returning the revised review never repeats execute automatically.
    return finishBrowserCandidate(kernel, result, blockNumber, balance, options);
  }
  return result.kind === "transaction" && result.status === "signed" && result.transactionHash ? broadcastSaved(kernel, result, options) : result;
}

export async function reconcileBrowserOperation(kernel: OperationKernel, operation: Operation, options: OperationOptions = {}): Promise<Operation> {
  const saved = await readBrowserOperation(kernel, identityOf(operation));
  if (!saved) throw new Error("not_found");
  if (saved.status === "signing" && !saved.transactionHash) return parseOperation(await kernel.updateSelf(METHODS.status, [{ identity: identityOf(saved), refresh: false }], 120));
  if (!saved.transactionHash) return saved;
  const successor = unwrap(await kernel.querySelf("evm_wallet_superseding_v1", [{ identity: identityOf(saved) }]));
  let replacementError: unknown;
  if (successor !== null) {
    const replacement = parseOperation(successor);
    if (BigInt(replacement.operationId) <= BigInt(saved.operationId) || replacement.chainId !== saved.chainId || replacement.accountId !== saved.accountId || replacement.preparedTransaction?.nonce !== saved.preparedTransaction?.nonce) throw new Error("Wallet returned an invalid replacement link");
    try { await reconcileBrowserOperation(kernel, replacement, options); }
    catch (error) { options.signal?.throwIfAborted(); replacementError = error; }
  }
  const observed = await observeOperation(kernel, saved, options);
  if (replacementError && !["confirmed", "reverted", "replaced"].includes(observed.status)) throw replacementError;
  // Only an explicit status check can retry exact retained bytes. The backend
  // accessor refuses superseded originals and interrupted signing has no bytes.
  if (successor === null && ["signed", "unknown"].includes(observed.status) && !observed.replacementTransactionHash && !observed.receiptJson) {
    const transaction = await rpc(operation.chainId, "eth_getTransactionByHash", [observed.transactionHash], options);
    if (transaction === null) return broadcastSaved(kernel, observed, options);
  }
  return observed;
}

export async function refreshBrowserEvidence(kernel: OperationKernel, operation: Operation, refresh: boolean, options: OperationOptions = {}): Promise<Operation> {
  const identity = identityOf(operation);
  const saved = parseReviewEvidence(await kernel.updateSelf(METHODS.reviewEvidence, [{ identity, review_revision: operation.reviewRevision, refresh: false }], 120));
  if (!refresh && saved.tokenEvidence) return saved;
  const tx = saved.preparedTransaction;
  if (!tx || saved.status !== "prepared") return saved;
  let decoded;
  try { decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex }); } catch { return saved; }
  if (!["approve", "transfer", "transferFrom"].includes(decoded.functionName)) return saved;
  const args = decoded.args as readonly unknown[];
  const owner = decoded.functionName === "transferFrom" ? String(args[0]) : saved.address;
  const spender = decoded.functionName === "approve" ? String(args[0]) : decoded.functionName === "transferFrom" ? saved.address : null;
  let observation: SelfCallObject;
  try {
    const block = await rpc<Record<string, unknown>>(saved.chainId, "eth_getBlockByNumber", ["latest", false], options);
    const blockNumber = quantity(decimal(block.number));
    const readValue = async (data: string): Promise<SelfCallObject> => {
      try {
        const value = await rpc<string>(saved.chainId, "eth_call", [{ from: saved.address, to: tx.to, data }, blockNumber], options);
        if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("Contract read did not return an ERC20 uint256 word");
        return { value: BigInt(value).toString() };
      } catch (error) { return { error: errorMessage(error) }; }
    };
    const [balance, allowance] = await Promise.all([
      readValue(encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner as Hex] })),
      spender ? readValue(encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner as Hex, spender as Hex] })) : Promise.resolve(null),
    ]);
    observation = { block_number: blockNumber, block_hash: String(block.hash), balance, ...(allowance ? { allowance } : {}) };
  } catch (error) {
    observation = { block_error: errorMessage(error), balance: { error: errorMessage(error) }, ...(spender ? { allowance: { error: errorMessage(error) } } : {}) };
  }
  options.signal?.throwIfAborted();
  return parseReviewEvidence(await kernel.updateSelf("evm_wallet_observe_evidence_browser_v1", [{ identity, review_revision: saved.reviewRevision, observation }], 120));
}
