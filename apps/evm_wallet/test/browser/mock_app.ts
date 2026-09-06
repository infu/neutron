/** Browser fixture: only the Kernel bridge and projected backend replies are mocked. */
import { Validator } from "jsonschema";
import { EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";
import { normalizeToolDescriptor } from "neutron-tools/protocol";
import { keccak256, serializeTransaction, type Hex } from "viem";
import { handleHumanEffect, type ProviderKind } from "../../src/provider.ts";

const validator = new Validator();
const address = "0x2222222222222222222222222222222222222222";
const recipient = "0x4444444444444444444444444444444444444444";
const stamp = "1788652800000000000";
const account = { id: "main", slot: "main", address, public_key: new Uint8Array(33).fill(2), namespace_version: "1" };
const snapshot = {
  accounts: [account],
  networks: [{ chain_id: "1", name: "Ethereum", native_symbol: "ETH", explorer_url: "https://etherscan.io", testnet: false, finality_description: "Ethereum finality" }],
  assets: [{ chain_id: "1", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: "6", custom: true }], lifecycle: "active",
};
const originalTransaction = {
  transaction_type: "eip1559", to: recipient, value: "1000000000000000", data: "0x", access_list: [],
  chain_id: "1", nonce: "17", gas_limit: "65000", max_fee_per_gas: "20000000000", max_priority_fee_per_gas: "1000000000", gas_price: null,
};
const original = {
  caller: { app_id: "evm_wallet", installation_uid: "12", endpoint: "app:evm_wallet:tile:evm_wallet" },
  operation_id: "100", request_id: "ab".repeat(16), account_id: "main", chain_id: "1", kind: "transaction", status: "submitted", address,
  transaction_hash: "0x" + "ab".repeat(32), replacement_hash: null, signature: null, message: null, review_revision: "1",
  review: { nonce: "17", gas_limit: "65000", max_fee_per_gas: "20000000000", max_priority_fee_per_gas: "1000000000", gas_price: null, balance: "1234567890123456789", simulation: "Call succeeded at the observed block", observed_at: stamp },
  prepared_transaction: originalTransaction, receipt_json: null, finality: null, created_at: stamp, updated_at: stamp,
  intent: { account_id: "main", chain_id: "1", operation: { transaction: { to: recipient, value: "1000000000000000", data: "0x", access_list: [] } } },
};
const calls: Array<{ method: string; args: any[] }> = [];
const toolCalls: any[] = [];
const routing: any[] = [];
const tileEndpoint = "app:evm_wallet:tile:evm_wallet:instance:browser-qualification";
const residentEndpoint = "app:evm_wallet:background";
const operations = new Map<string, any>([[original.request_id, original]]);
const signedBytes = new Map<string, Hex>();
const registrations = new Map<string, any>();
const gates = new Map<string, { wait: Promise<void>; release: () => void }>();
let sequence = 100;
const copy = <T,>(value: T): T => structuredClone(value);
const historyAttempts: any[] = [];
const requestedHistoryRows = Number(new URLSearchParams(location.search).get("history") ?? "0");
const capturedHistory = (window as any).__evmCapturedHistory as { operations: any[]; total: string } | undefined;
const historyRows = requestedHistoryRows > 0 ? Array.from({ length: requestedHistoryRows }, (_, index) => {
  if (!capturedHistory?.operations.length) throw new Error("Captured history fixture was not loaded");
  const operation = copy(capturedHistory.operations[index % capturedHistory.operations.length]);
  // The first 25 rows are exact captured responses. A second copy with unique
  // IDs exercises a failing Load more response as well as a failing first page.
  if (index >= capturedHistory.operations.length) {
    operation.operation_id = String(10000 + index);
    operation.request_id = (10000 + index).toString(16).padStart(32, "0");
  }
  return operation;
}) : null;

function validate(value: unknown, schema: any) {
  const result = validator.validate(value, schema);
  if (!result.valid) throw new Error(result.errors.map((error) => error.stack).join("; "));
}
export const loadTileContext = () => ({ app: "evm_wallet", tile: "evm_wallet" });
export const copyToClipboard = async () => undefined;
export const onAppStateChange = () => () => undefined;
export function exposeTool(name: string, definition: any, handler: any) {
  // Registration must cross the real SDK descriptor validator. Plain JSON
  // validation alone missed the unsafe-regex startup failure in production.
  registrations.set(name, { definition: normalizeToolDescriptor({ name, ...definition }), handler });
  return () => registrations.delete(name);
}
export async function querySelf(method: string, args: any[]) {
  calls.push({ method, args: copy(args) });
  if (method === "evm_wallet_snapshot_v1") return { ok: copy(snapshot) };
  if (method === "evm_wallet_operation_v1") {
    const operation = operations.get(args[0].identity.request_id);
    return operation ? { ok: copy(operation) } : { err: "not_found" };
  }
  if (method === "evm_wallet_superseding_v1") return { ok: null };
  if (method === "evm_wallet_submission_v1") {
    const operation = operations.get(args[0].identity.request_id);
    const raw = signedBytes.get(args[0].identity.request_id);
    if (!operation || !raw) throw new Error("No signed transaction");
    return { ok: { chain_id: operation.chain_id, transaction_hash: operation.transaction_hash, raw_transaction: raw } };
  }
  if (method === "evm_wallet_history_v1") {
    if (!historyRows) return { ok: { operations: copy([...operations.values()]), total: String(operations.size) } };
    const offset = Number(args[0].offset), limit = Number(args[0].limit);
    const page = { operations: copy(historyRows.slice(offset, offset + limit)), total: String(historyRows.length) };
    const attempt = { offset, limit, operationIds: page.operations.map(operation => operation.operation_id), metadataBytes: new TextEncoder().encode(JSON.stringify(page)).byteLength, accepted: false };
    historyAttempts.push(attempt);
    // Execute the existing Kernel codec itself. The helper under test must
    // adapt to that transport's exact rejection, not a fixture's invented cap.
    (window as any).__evmKernelEncodeSelfCallResult(page);
    attempt.accepted = true;
    return page;
  }
  throw new Error(`Unexpected query ${method}`);
}
export async function updateSelf(method: string, args: any[]) {
  calls.push({ method, args: copy(args) });
  await gates.get(method)?.wait;
  const outerArg = args[0];
  const arg = method === "evm_wallet_prepare_browser_v1" ? outerArg.request : outerArg;
  if (method === "evm_wallet_accounts_v1") return { ok: [copy(account)] };
  if (method === "evm_wallet_balances_v1") return { ok: {
    account_id: "main", chain_id: arg.chain_id, address, native_balance: "1234567890123456789",
    block_number: "23901234", observed_at: stamp, completeness: "selected_assets", tokens: [],
  } };
  if (method === "evm_wallet_asset_set_v1") return { ok: null };
  if (method === "evm_wallet_prepare_browser_v1") {
    const saved = operations.get(arg.identity.request_id);
    if (saved) return { ok: copy(saved) };
    const intent = copy(arg.intent), variant = intent.operation;
    const transaction = variant.transaction ?? (variant.replacement ? {
      ...originalTransaction,
      ...(variant.replacement.cancel ? { to: address, value: "0", data: "0x" } : {}),
      max_fee_per_gas: variant.replacement.max_fee_per_gas,
      max_priority_fee_per_gas: variant.replacement.max_priority_fee_per_gas,
    } : null);
    const preparedTransaction = transaction ? {
      ...originalTransaction, ...transaction, chain_id: intent.chain_id, nonce: "17",
    } : null;
    const kind = transaction ? "transaction" : variant.personal_message ? "message" : "typed_data";
    const operation = {
      ...copy(original), caller: copy(arg.identity.caller), operation_id: String(++sequence), request_id: arg.identity.request_id,
      account_id: intent.account_id, chain_id: intent.chain_id, kind, status: transaction ? "preparing" : "prepared", transaction_hash: null,
      prepared_transaction: preparedTransaction,
      review: preparedTransaction ? {
        ...original.review, max_fee_per_gas: preparedTransaction.max_fee_per_gas,
        max_priority_fee_per_gas: preparedTransaction.max_priority_fee_per_gas,
      } : null,
      intent,
    };
    operations.set(operation.request_id, operation);
    return { ok: copy(operation) };
  }
  const operation = operations.get(arg.identity?.request_id);
  if (!operation) throw new Error(`Unknown operation for ${method}`);
  if (method === "evm_wallet_finish_prepare_browser_v1") {
    operation.status = "prepared";
    operation.prepared_transaction.gas_limit = arg.gas_limit;
    operation.review.gas_limit = arg.gas_limit;
    operation.review.simulation = arg.simulation;
    return { ok: copy(operation) };
  }
  if (method === "evm_wallet_review_evidence_v1") return { operation: copy(operation), token_evidence: null };
  if (method === "evm_wallet_observe_evidence_browser_v1") return { operation: copy(operation), token_evidence: null };
  if (method === "evm_wallet_status_v1") return { ok: copy(operation) };
  if (method === "evm_wallet_reject_v1") {
    operation.status = "rejected";
    return { ok: copy(operation) };
  }
  if (method === "evm_wallet_execute_v1") {
    if (operation.status !== "prepared" || operation.review_revision !== arg.review_revision) throw new Error("Execution requires the exact prepared review");
    const tx = operation.prepared_transaction;
    if (!tx) throw new Error("This fixture explicitly executes transactions only");
    const raw = serializeTransaction({ type: "eip1559", chainId: Number(tx.chain_id), nonce: Number(tx.nonce), gas: BigInt(tx.gas_limit), to: tx.to, value: BigInt(tx.value), data: tx.data,
      maxFeePerGas: BigInt(tx.max_fee_per_gas), maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas) },
      { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 0 });
    signedBytes.set(operation.request_id, raw);
    operation.status = "signed";
    operation.transaction_hash = keccak256(raw);
    return { ok: copy(operation) };
  }
  if (method === "evm_wallet_observe_browser_v1") {
    if (operation.transaction_hash !== arg.transaction_hash) throw new Error("Observation hash does not match the signed request");
    operation.status = JSON.parse(arg.transaction_json) ? "submitted" : "unknown";
    return { ok: copy(operation) };
  }
  throw new Error(`Unexpected update ${method}`);
}
const publicTools: Record<string, ProviderKind> = {
  [EVM_WALLET_TOOLS.sendTransaction]: "transaction",
  [EVM_WALLET_TOOLS.signMessage]: "message",
  [EVM_WALLET_TOOLS.signTypedData]: "typed_data",
  [EVM_WALLET_TOOLS.replaceTransaction]: "replacement",
};
function describeContext(context: any) {
  return {
    caller: copy(context.caller),
    hasPresenter: Object.hasOwn(context, "presentUserInterface"),
    hasAudience: Object.hasOwn(context, "audience"),
  };
}
export async function callTool(request: any) {
  toolCalls.push(copy(request));
  if (request.name === EVM_WALLET_TOOLS.balances) return {
    accountId: "main", chainId: request.arguments.chainId, address, nativeBalanceWei: "1234567890123456789",
    blockNumber: "23901234", observedAtNs: stamp, completeness: "requested_only",
    tokens: request.arguments.tokens.map((token: string) => ({ address: token, symbol: "USDC", decimals: "6", balanceAtoms: "100000000", error: null })),
  };
  if (request.name === EVM_WALLET_TOOLS.accounts) return { accounts: [{
    accountId: "main", address, publicKey: "0x02" + "22".repeat(32), keyFingerprint: "0x" + "11".repeat(32), namespaceVersion: "1",
  }] };
  if (request.name === EVM_WALLET_TOOLS.operationStatus) return {
    ...request.arguments, status: "not_found",
  };
  const kind = publicTools[request.name];
  if (!kind) throw new Error(`Unexpected tool ${request.name}`);
  if (request.target !== residentEndpoint) throw new Error("Own Wallet effect must first call its resident service");
  const signal = new AbortController().signal;
  // Actual Kernel same-app calls have no provider presenter or attested
  // foreground audience. Exercise the production resident handler with that
  // context, instead of bypassing it for the foreground private tool.
  const context = {
    caller: { appId: "evm_wallet", installationUid: "12", endpoint: tileEndpoint, role: "tile" },
    signal,
    kernel: {
      querySelf, updateSelf,
      async callTool(forwarded: any) {
        if (forwarded.target !== tileEndpoint) throw new Error("Resident did not route back to the authenticated owner tile instance");
        const registration = registrations.get(forwarded.name);
        if (!registration) throw new Error(`Owner review tool not registered: ${forwarded.name}`);
        if (registration.definition.annotations?.["neutron:visibility"] !== "same_app") throw new Error("Owner review tool is not scoped to the same app");
        if (registration.definition.annotations?.["neutron:audience"] !== undefined) throw new Error("Own review incorrectly requires foreground provider attestation");
        validate(forwarded.arguments, registration.definition.inputSchema);
        const ownerContext = {
          caller: { appId: "evm_wallet", installationUid: "12", endpoint: residentEndpoint, role: "background" },
          signal, kernel: { querySelf, updateSelf },
        };
        routing.push({ leg: "resident_to_owner", target: forwarded.target, tool: forwarded.name, ...describeContext(ownerContext) });
        const result = await registration.handler(forwarded.arguments, ownerContext);
        validate(result, registration.definition.outputSchema);
        return result;
      },
    },
  };
  routing.push({ leg: "tile_to_resident", target: request.target, tool: request.name, ...describeContext(context) });
  return handleHumanEffect(kind, request.arguments, context as any);
}
(window as any).__evmSandbox = {
  calls, toolCalls, routing, historyAttempts, expectedHistoryIds: historyRows?.map(operation => operation.operation_id),
  hold(method: string) {
    if (gates.has(method)) throw new Error(`Already held: ${method}`);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    gates.set(method, { wait, release });
  },
  release(method: string) {
    const gate = gates.get(method);
    if (!gate) throw new Error(`Not held: ${method}`);
    gates.delete(method);
    gate.release();
  },
};
