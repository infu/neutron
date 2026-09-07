/** Browser fixture: only the Kernel bridge and projected backend replies are mocked. */
import { Validator } from "jsonschema";
import { EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";
import { curatedEvmTokens } from "neutron-tools/src/evm_assets.js";
import { normalizeToolDescriptor } from "neutron-tools/protocol";
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction, type Hex } from "viem";
import { handleHumanEffect, type ProviderKind } from "../../src/provider.ts";
import { callContract as readContractCall } from "../../src/read_adapters.ts";

const validator = new Validator();
const address = "0x2222222222222222222222222222222222222222";
const recipient = "0x4444444444444444444444444444444444444444";
const stamp = "1788652800000000000";
const account = { id: "main", slot: "main", address, public_key: new Uint8Array(33).fill(2), namespace_version: "1" };
const snapshot = {
  accounts: [account],
  networks: [
    { chain_id: "1", name: "Ethereum", native_symbol: "ETH", explorer_url: "https://etherscan.io", testnet: false, finality_description: "Ethereum finality" },
    { chain_id: "42161", name: "Arbitrum", native_symbol: "ETH", explorer_url: "https://arbiscan.io", testnet: false, finality_description: "Arbitrum finality" },
  ],
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
const appStateListeners = new Map<string, Set<(event: any) => void>>();
let sequence = 100;
const copy = <T,>(value: T): T => structuredClone(value);
// The projected backend owns these records, independently of React state and
// the opaque origin's unavailable local storage. Reload tests restore this
// exact backend snapshot before constructing the next Wallet instance.
const decoderPacks = new Map<string, any>(((window as any).__evmDecoderInitialPacks ?? []).map((row: any) => [row.id, copy(row)]));
const backendSchemas = (window as any).__evmBackendSchemas as Record<string, any> | undefined;
function decoderReply(method: string, args: any[], value: unknown) {
  const schema = backendSchemas?.[method];
  if (!schema) throw new Error(`Missing actual generated backend schema: ${method}`);
  validate(args, { ...schema.input, items: schema.input.prefixItems, additionalItems: false });
  validate(value, schema.output);
  return copy(value);
}
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

if (new URLSearchParams(location.search).has("decoders")) {
  operations.clear();
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const unknownToken = "0x7777777777777777777777777777777777777777", unavailableToken = "0x8888888888888888888888888888888888888888";
  const pool = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", protocol = "0x6666666666666666666666666666666666666666";
  const abi = parseAbi(["function deposit(address,uint256,address)", "function repay(address,uint256,uint256,address)", "function supply(address,uint256,address,uint16)", "function approve(address,uint256)", "function transfer(address,uint256)"]);
  const add = (id: number, to: string, data: Hex, status = "confirmed", value = "0") => {
    const row = copy(original);
    Object.assign(row, { operation_id: String(id), request_id: id.toString(16).padStart(32, "0"), status, finality: status === "confirmed" ? "confirmed" : null,
      transaction_hash: `0x${id.toString(16).padStart(64, "0")}`, caller: { ...row.caller, app_id: "fixture_protocol" } });
    row.prepared_transaction = { ...row.prepared_transaction, to, data, value };
    row.intent = { ...row.intent, operation: { transaction: { to, data, value, access_list: [] } } };
    operations.set(row.request_id, row);
  };
  add(201, protocol, encodeFunctionData({ abi, functionName: "deposit", args: [unknownToken, 123456789n, address] }));
  add(202, pool, encodeFunctionData({ abi, functionName: "repay", args: [usdc, (1n << 256n) - 1n, 2n, address] }));
  add(203, pool, encodeFunctionData({ abi, functionName: "supply", args: [usdc, 123456789012345678901234567890123456789012345678901234567n, address, 0] }));
  add(204, unknownToken, encodeFunctionData({ abi, functionName: "transfer", args: [recipient, 765432109n] }));
  add(205, unavailableToken, encodeFunctionData({ abi, functionName: "transfer", args: [recipient, 123456789n] }));
  add(206, usdc, encodeFunctionData({ abi, functionName: "approve", args: [protocol, 123000000n] }));
  const swapAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)", "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])", "function refundETH() payable"]);
  const swap = encodeFunctionData({ abi: swapAbi, functionName: "multicall", args: [2_000_000_000n, [encodeFunctionData({ abi: swapAbi, functionName: "exactInputSingle", args: [{ tokenIn: weth, tokenOut: usdc, fee: 3000, recipient, amountIn: 1_000_000_000_000_000n, amountOutMinimum: 995_000n, sqrtPriceLimitX96: 0n }] }), encodeFunctionData({ abi: swapAbi, functionName: "refundETH" })]] });
  add(207, "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", swap, "submitted", "1000000000000000");
  const zero = "0x0000000000000000000000000000000000000000", curvePool = "0x5555555555555555555555555555555555555555";
  const curve = encodeFunctionData({ abi: parseAbi(["function exchange(address[11],uint256[5][5],uint256,uint256,address[5],address) payable returns (uint256)"]), functionName: "exchange", args: [["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", weth, weth, curvePool, usdc, zero, zero, zero, zero, zero, zero], [[0n, 0n, 8n, 0n, 0n], [2n, 0n, 1n, 30n, 3n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]], 1_000_000_000_000_000n, 995_000n, [zero, zero, zero, zero, zero], recipient] });
  add(208, "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e", curve, "reverted", "1000000000000000");
  // A prepared request exercises the same imported explanation in human review.
  add(209, protocol, encodeFunctionData({ abi, functionName: "deposit", args: [unknownToken, 222222222n, address] }), "prepared");
  sequence = 209;
}

if (new URLSearchParams(location.search).has("approvals")) {
  operations.clear();
  const row = copy(original);
  const to = "0x9999999999999999999999999999999999999999";
  const data = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [recipient, 7n] });
  Object.assign(row, { status: "confirmed", finality: "finalized", receipt_json: JSON.stringify({ transactionHash: row.transaction_hash, status: "0x1" }) });
  row.prepared_transaction = { ...row.prepared_transaction, to, data, value: "0" };
  row.intent = { ...row.intent, operation: { transaction: { to, data, value: "0", access_list: [] } } };
  operations.set(row.request_id, row);
}

function validate(value: unknown, schema: any) {
  const result = validator.validate(value, schema);
  if (!result.valid) throw new Error(result.errors.map((error) => error.stack).join("; "));
}
export const loadTileContext = () => ({ app: "evm_wallet", tile: "evm_wallet" });
export const copyToClipboard = async () => undefined;
export function onAppStateChange(topic: string, listener: (event: any) => void) {
  const listeners = appStateListeners.get(topic) ?? new Set();
  listeners.add(listener);
  appStateListeners.set(topic, listeners);
  return () => { listeners.delete(listener); };
}
export async function publishAppStateChange(topic: string, revision: string | number) {
  for (const listener of appStateListeners.get(topic) ?? []) listener({ topic, revision: String(revision) });
}
export function exposeTool(name: string, definition: any, handler: any) {
  // Registration must cross the real SDK descriptor validator. Plain JSON
  // validation alone missed the unsafe-regex startup failure in production.
  registrations.set(name, { definition: normalizeToolDescriptor({ name, ...definition }), handler });
  return () => registrations.delete(name);
}
export async function querySelf(method: string, args: any[]) {
  calls.push({ method, args: copy(args) });
  if (method === "evm_wallet_decoder_packs_v1") return decoderReply(method, args, { packs: [...decoderPacks.values()] });
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
    // Hold the captured reply to reproduce an update arriving while an older
    // history refresh is in flight, rather than changing the reply afterward.
    await gates.get(method)?.wait;
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
  if (method === "evm_wallet_decoder_set_v1") {
    const previous = decoderPacks.get(arg.id);
    if (previous && BigInt(arg.version) < BigInt(previous.version)) throw new Error("A decoder pack update must use a higher version");
    if (previous && arg.version === previous.version && arg.document_json !== previous.document_json) throw new Error("Decoder pack content is immutable at the same id and version");
    const saved = { ...copy(arg), created_at: decoderPacks.get(arg.id)?.created_at ?? stamp, updated_at: stamp };
    const response = decoderReply(method, args, saved);
    decoderPacks.set(arg.id, saved);
    return response;
  }
  if (method === "evm_wallet_decoder_remove_v1") {
    const exists = decoderPacks.has(arg);
    const response = decoderReply(method, args, exists);
    decoderPacks.delete(arg);
    return response;
  }
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
  if (request.name === EVM_WALLET_TOOLS.callContract) return readContractCall(request.arguments, {
    signal: new AbortController().signal,
    kernel: { querySelf, updateSelf },
  } as any);
  if (request.name === EVM_WALLET_TOOLS.prices) {
    if (new URLSearchParams(location.search).get("usd") === "unavailable") throw new Error("Price provider is unavailable");
    return { source: "defillama", prices: request.arguments.assets.map((asset: any) => {
      const priceUsd = asset.address === null ? 3000 : asset.address.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" ? 0.997 : null;
      return { ...asset, priceUsd, observedAtMs: priceUsd === null ? null : Date.now(), fetchedAtMs: Date.now(), status: priceUsd === null ? "unavailable" : "available", basis: "market", sourceId: priceUsd === null ? null : asset.address === null ? "coingecko:ethereum" : `ethereum:${asset.address.toLowerCase()}`, error: priceUsd === null ? "No market price" : null };
    }) };
  }
  if (request.name === EVM_WALLET_TOOLS.balances) {
    await gates.get("balances_read")?.wait;
    return {
    accountId: "main", chainId: request.arguments.chainId, address, nativeBalanceWei: "1234567890123456789",
    blockNumber: "23901234", observedAtNs: stamp, completeness: "requested_only",
    tokens: request.arguments.tokens.map((token: string) => {
      const asset = curatedEvmTokens(request.arguments.chainId).find((entry) => entry.address?.toLowerCase() === token.toLowerCase());
      return { address: token, symbol: asset?.symbol ?? "Token", decimals: String(asset?.decimals ?? 18), balanceAtoms: asset?.symbol === "USDC" ? "100000000" : asset?.symbol === "WBTC" ? "1000000" : "0", error: null };
    }),
    };
  }
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
  decoderSnapshot: () => copy([...decoderPacks.values()]),
  async setDecoderEnabled(id: string, enabled: boolean) {
    const pack = decoderPacks.get(id);
    if (!pack) throw new Error(`Unknown decoder pack ${id}`);
    pack.enabled = enabled;
    await publishAppStateChange("evm_wallet", Date.now());
  },
  operationSnapshot: () => copy([...operations.values()]),
  historySnapshot: () => copy(historyRows),
  setHistoryStatus(id: string, status: string, finality: string | null = null) {
    const operation = historyRows?.find((row) => row.operation_id === id);
    if (!operation) throw new Error(`Unknown historical operation ${id}`);
    operation.status = status;
    operation.finality = finality;
  },
  prependHistory(count: number) {
    if (!historyRows || !capturedHistory) throw new Error("History fixture was not loaded");
    const newest = Math.max(200000, ...historyRows.map((row) => Number(row.operation_id))) + count;
    historyRows.unshift(...Array.from({ length: count }, (_, index) => ({
      ...copy(capturedHistory.operations[0]),
      operation_id: String(newest - index),
      request_id: (newest - index).toString(16).padStart(32, "0"),
    })));
  },
  publishAppStateChange,
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
