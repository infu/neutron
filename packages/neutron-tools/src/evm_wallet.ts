/**
 * Versioned EVM Wallet consumer protocol.
 *
 * Inject the current invocation's context.kernel when forwarding a tool call.
 * The client never supplies caller identity, receives a signing capability, or
 * changes wallet-global account/network selection. Amounts are atomic decimal
 * strings; EIP-712 JSON is kept exactly as supplied for review and hashing.
 */
import {
  isMsgBusInstallationUid, type JsonObject, type JsonValue, type MsgBusCallOptions, type MsgBusClient, type MsgBusToolContext,
} from "./protocol.ts";

export const EVM_WALLET_TARGET = "app:evm_wallet:background" as const;
export const EVM_WALLET_TOOLS = {
  accounts: "evm_accounts_v1",
  networks: "evm_networks_v1",
  balances: "evm_balances_v1",
  readContract: "evm_read_contract_v1",
  callContract: "evm_call_contract_v1",
  estimateTransaction: "evm_estimate_transaction_v1",
  sendTransaction: "evm_send_transaction_v1",
  sendTransactionRoot: "evm_send_transaction_root_v1",
  signMessage: "evm_sign_message_v1",
  signMessageRoot: "evm_sign_message_root_v1",
  signTypedData: "evm_sign_typed_data_v1",
  signTypedDataRoot: "evm_sign_typed_data_root_v1",
  operationStatus: "evm_operation_status_v1",
  transaction: "evm_transaction_v1",
  replacementTransaction: "evm_replacement_transaction_v1",
  replaceTransaction: "evm_replace_transaction_v1",
  replaceTransactionRoot: "evm_replace_transaction_root_v1",
} as const;

export type EvmAccountId = "main";
export type EvmScope = { accountId: EvmAccountId; chainId: string };
export type EvmEffectIdentity = EvmScope & { requestId: string };
export type EvmAccessListEntry = { address: string; storageKeys: string[] };
export type EvmSendTransactionRequest = EvmEffectIdentity & {
  to: string;
  valueWei: string;
  data: string;
  transactionType?: "eip1559" | "legacy";
  gasLimit?: string;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  gasPriceWei?: string;
  accessList?: EvmAccessListEntry[];
};
export type EvmReplaceTransactionRequest = EvmEffectIdentity & {
  operationId: string;
  cancel: boolean;
  maxFeePerGasWei: string;
  maxPriorityFeePerGasWei: string;
};
export type EvmSignMessageRequest = EvmEffectIdentity & { messageHex: string };
export type EvmSignTypedDataRequest = EvmEffectIdentity & { typedDataJson: string };
export type EvmBalancesRequest = EvmScope & { tokens: string[] };
export type EvmReadContractRequest = EvmScope & { to: string; data: string };
/** Read return bytes without downloading code; an explicit block pins dependent reads. */
export type EvmCallContractRequest = EvmReadContractRequest & { blockTag?: string };
/** A read-only estimate for this exact call; it grants no transaction authority. */
export type EvmEstimateTransactionRequest = EvmScope & { to: string; valueWei: string; data: string };
export type EvmOperationStatusRequest = EvmEffectIdentity;
export type EvmEffectKind = "transaction" | "message" | "typed_data";
export type EvmEffectRequest = EvmSendTransactionRequest | EvmSignMessageRequest | EvmSignTypedDataRequest;

export type EvmAccount = {
  accountId: EvmAccountId;
  address: string;
  publicKey: string;
  keyFingerprint: string;
  namespaceVersion: string;
};
export type EvmAccountsResult = { accounts: EvmAccount[] };
export type EvmNetwork = {
  chainId: string;
  name: string;
  nativeSymbol: string;
  nativeDecimals: string;
  explorerUrl: string;
  feeModel: "eip1559" | "legacy";
  finalityKind: "ethereum" | "arbitrum";
};
export type EvmNetworksResult = { networks: EvmNetwork[] };
export type EvmTokenBalance = { address: string; balanceAtoms: string | null; decimals: string | null; symbol: string | null; error: string | null };
export type EvmBalancesResult = EvmScope & {
  address: string;
  nativeBalanceWei: string;
  tokens: EvmTokenBalance[];
  blockNumber: string;
  observedAtNs: string;
  completeness: "requested_only";
};
export type EvmReadContractResult = EvmScope & {
  address: string;
  to: string;
  data: string;
  result: string;
  code: string;
  blockNumber: string;
  observedAtNs: string;
};
export type EvmCallContractResult = Omit<EvmReadContractResult, "code">;
export type EvmEstimateTransactionResult = EvmEstimateTransactionRequest & {
  address: string;
  status: "available" | "unavailable";
  gasLimit: string | null;
  /** Raw eth_gasPrice observation, which can differ from base fee plus tip. */
  gasPriceWei: string | null;
  baseFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  maxFeePerGasWei: string | null;
  /** Gas estimate times current price; excludes the transferred value. */
  estimatedFeeWei: string | null;
  /** Gas estimate times suggested maximum price; not an authorized spending cap. */
  maximumFeeWei: string | null;
  blockNumber: string | null;
  /** Observations can span RPC calls and are not a single atomic block snapshot. */
  observedAtNs: string;
  feeBasis: "base_fee_plus_priority" | "gas_price" | "arbitrum_total_gas" | "unavailable";
  /** Arbitrum's total gas estimate already includes posting; never add it twice. */
  postingCosts: "included" | "not_applicable" | "unavailable";
  reasons: string[];
  source: "evm_rpc";
};
export type EvmReceiptLog = { address: string; data: string; topics: string[]; logIndex: string };
export type EvmReceipt = {
  blockNumber: string;
  blockHash: string;
  status: "success" | "reverted";
  gasUsed: string;
  effectiveGasPriceWei: string;
  logs: EvmReceiptLog[];
  finality: "included" | "safe" | "finalized";
  observedAtNs: string;
};
export const EVM_OPERATION_STATUSES = [
  "preparing", "prepared", "signing", "signed", "submitted", "confirmed", "reverted", "rejected", "unknown", "failed", "replaced",
] as const;
export type EvmOperationStatus = typeof EVM_OPERATION_STATUSES[number];
export type EvmOperationResult = EvmEffectIdentity & {
  operationId: string;
  kind: EvmEffectKind;
  status: EvmOperationStatus;
  address: string;
  transactionHash: string | null;
  replacementTransactionHash?: string | null;
  signature: string | null;
  message: string | null;
  reviewRevision: string;
  receipt: EvmReceipt | null;
};
export type EvmOperationNotFound = EvmEffectIdentity & { status: "not_found" };
export type EvmOperationStatusResult = EvmOperationResult | EvmOperationNotFound;
export type EvmWalletCaller = { appId: string; installationUid: string };

const UINT = { type: "string", pattern: "^0$|^[1-9][0-9]*$" } satisfies JsonObject;
const POSITIVE_UINT = { type: "string", pattern: "^[1-9][0-9]*$" } satisfies JsonObject;
const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } satisfies JsonObject;
const HEX = { type: "string", pattern: "^0x[0-9a-fA-F]*$" } satisfies JsonObject;
const HASH = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } satisfies JsonObject;
const SIGNATURE = { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" } satisfies JsonObject;
const TEXT = { type: "string" } satisfies JsonObject;
const scopeProperties = { accountId: { const: "main" }, chainId: POSITIVE_UINT };
const identityProperties = { ...scopeProperties, requestId: { type: "string", pattern: "^[0-9a-f]{32}$" } };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const array = (items: JsonObject): JsonObject => ({ type: "array", items });
function closedSchema(properties: JsonObject, optional: readonly string[] = []): JsonObject {
  return { type: "object", properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false };
}
export const evmEmptyInputSchema = closedSchema({});
export const evmAccountsInputSchema = evmEmptyInputSchema;
export const evmNetworksInputSchema = evmEmptyInputSchema;
export const evmBalancesInputSchema = closedSchema({ ...scopeProperties, tokens: array(ADDRESS) });
export const evmReadContractInputSchema = closedSchema({ ...scopeProperties, to: ADDRESS, data: HEX });
export const evmCallContractInputSchema = closedSchema({
  ...scopeProperties, to: ADDRESS, data: HEX,
  blockTag: { oneOf: [{ const: "latest" }, UINT, { type: "string", pattern: "^0x[0-9a-fA-F]+$" }] },
}, ["blockTag"]);
export const evmEstimateTransactionInputSchema = closedSchema({ ...scopeProperties, to: ADDRESS, valueWei: UINT, data: HEX });
export const evmSendTransactionInputSchema = closedSchema({
  ...identityProperties, to: ADDRESS, valueWei: UINT, data: HEX,
  transactionType: { enum: ["eip1559", "legacy"] }, gasLimit: POSITIVE_UINT,
  maxFeePerGasWei: UINT, maxPriorityFeePerGasWei: UINT, gasPriceWei: UINT,
  accessList: array(closedSchema({ address: ADDRESS, storageKeys: array(HASH) })),
}, ["transactionType", "gasLimit", "maxFeePerGasWei", "maxPriorityFeePerGasWei", "gasPriceWei", "accessList"]);
export const evmReplaceTransactionInputSchema = closedSchema({
  ...identityProperties, operationId: UINT, cancel: { type: "boolean" },
  maxFeePerGasWei: UINT, maxPriorityFeePerGasWei: UINT,
});
export const evmSignMessageInputSchema = closedSchema({ ...identityProperties, messageHex: HEX });
export const evmSignTypedDataInputSchema = closedSchema({ ...identityProperties, typedDataJson: TEXT });
export const evmOperationStatusInputSchema = closedSchema(identityProperties);
export const evmAccountSchema = closedSchema({
  accountId: { const: "main" }, address: ADDRESS,
  publicKey: { type: "string", pattern: "^0x0[23][0-9a-fA-F]{64}$|^0x04[0-9a-fA-F]{128}$" },
  keyFingerprint: HASH, namespaceVersion: POSITIVE_UINT,
});
export const evmAccountsOutputSchema = closedSchema({ accounts: array(evmAccountSchema) });
export const evmNetworksOutputSchema = closedSchema({ networks: array(closedSchema({
  chainId: POSITIVE_UINT, name: TEXT, nativeSymbol: TEXT, nativeDecimals: UINT, explorerUrl: TEXT,
  feeModel: { enum: ["eip1559", "legacy"] }, finalityKind: { enum: ["ethereum", "arbitrum"] },
})) });
export const evmBalancesOutputSchema = closedSchema({
  ...scopeProperties, address: ADDRESS, nativeBalanceWei: UINT,
  tokens: array(closedSchema({ address: ADDRESS, balanceAtoms: nullable(UINT), decimals: nullable(UINT), symbol: nullable(TEXT), error: nullable(TEXT) })),
  blockNumber: UINT, observedAtNs: UINT, completeness: { const: "requested_only" },
});
export const evmReadContractOutputSchema = closedSchema({
  ...scopeProperties, address: ADDRESS, to: ADDRESS, data: HEX, result: HEX, code: HEX, blockNumber: UINT, observedAtNs: UINT,
});
export const evmCallContractOutputSchema = closedSchema({
  ...scopeProperties, address: ADDRESS, to: ADDRESS, data: HEX, result: HEX, blockNumber: UINT, observedAtNs: UINT,
});
export const evmEstimateTransactionOutputSchema = closedSchema({
  ...scopeProperties, address: ADDRESS, to: ADDRESS, valueWei: UINT, data: HEX,
  status: { enum: ["available", "unavailable"] }, gasLimit: nullable(POSITIVE_UINT),
  gasPriceWei: nullable(UINT), baseFeePerGasWei: nullable(UINT), maxPriorityFeePerGasWei: nullable(UINT),
  maxFeePerGasWei: nullable(UINT), estimatedFeeWei: nullable(UINT), maximumFeeWei: nullable(UINT),
  blockNumber: nullable(UINT), observedAtNs: UINT,
  feeBasis: { enum: ["base_fee_plus_priority", "gas_price", "arbitrum_total_gas", "unavailable"] },
  postingCosts: { enum: ["included", "not_applicable", "unavailable"] }, reasons: array(TEXT), source: { const: "evm_rpc" },
});
export const evmReceiptSchema = closedSchema({
  blockNumber: UINT, blockHash: HASH, status: { enum: ["success", "reverted"] },
  gasUsed: UINT, effectiveGasPriceWei: UINT,
  logs: array(closedSchema({ address: ADDRESS, data: HEX, topics: array(HASH), logIndex: UINT })),
  finality: { enum: ["included", "safe", "finalized"] }, observedAtNs: UINT,
});
export const evmOperationOutputSchema = closedSchema({
  ...identityProperties, operationId: UINT, kind: { enum: ["transaction", "message", "typed_data"] },
  status: { enum: [...EVM_OPERATION_STATUSES] }, address: ADDRESS,
  transactionHash: nullable(HASH), replacementTransactionHash: nullable(HASH), signature: nullable(SIGNATURE), message: nullable(TEXT),
  reviewRevision: UINT, receipt: nullable(evmReceiptSchema),
}, ["replacementTransactionHash"]);
export const evmOperationStatusOutputSchema: JsonObject = { oneOf: [
  evmOperationOutputSchema, closedSchema({ ...identityProperties, status: { const: "not_found" } }),
] };
export const evmSendTransactionOutputSchema = evmOperationOutputSchema;
export const evmReplaceTransactionOutputSchema = evmOperationOutputSchema;
export const evmSignMessageOutputSchema = evmOperationOutputSchema;
export const evmSignTypedDataOutputSchema = evmOperationOutputSchema;

export class EvmWalletProtocolError extends Error {
  readonly code = "EVM_WALLET_PROTOCOL_ERROR";
  constructor(message: string) { super(message); this.name = "EvmWalletProtocolError"; }
}

function invalid(label: string): never { throw new EvmWalletProtocolError(`Invalid EVM Wallet ${label}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}
/** A small closed JSON-schema validator for the schemas exported above. */
function shape(value: unknown, schema: JsonObject, path: string): void {
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const option of schema.oneOf) {
      try { shape(value, option as JsonObject, path); matches++; } catch (error) {
        if (!(error instanceof EvmWalletProtocolError)) throw error;
      }
    }
    if (matches !== 1) invalid(path);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) invalid(path);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as JsonValue)) invalid(path);
  if (schema.type === "null") { if (value !== null) invalid(path); return; }
  if (schema.type === "boolean") { if (typeof value !== "boolean") invalid(path); return; }
  if (schema.type === "string") {
    if (typeof value !== "string") invalid(path);
    if (typeof schema.pattern === "string" && new RegExp(schema.pattern, "u").exec(value)?.[0] !== value) invalid(path);
    // Kernel descriptor regexes intentionally disallow grouped repetition.
    // The wire schema checks hex characters; the parser also checks bytes.
    if (schema === HEX && value.length % 2 !== 0) invalid(`${path} must contain complete hex bytes`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) invalid(path);
    for (const [index, item] of value.entries()) shape(item, schema.items as JsonObject, `${path}[${index}]`);
    return;
  }
  if (schema.type === "object") {
    const object = record(value, path);
    const properties = schema.properties as JsonObject;
    for (const required of schema.required as string[]) {
      if (!Object.prototype.hasOwnProperty.call(object, required)) invalid(`${path}.${required}`);
    }
    for (const key of Object.keys(object)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) invalid(`${path}.${key}`);
      shape(object[key], properties[key] as JsonObject, `${path}.${key}`);
    }
  }
}
function parseShape<T>(value: unknown, schema: JsonObject, label: string): T {
  shape(value, schema, label);
  // Inputs crossing the app boundary must be JSON. Copy so a consumer cannot
  // mutate the checked request while discovery or persistence is awaiting.
  return JSON.parse(JSON.stringify(value)) as T;
}
const MAX_UINT256 = (1n << 256n) - 1n;
function uint256(value: string, label: string): void { if (BigInt(value) > MAX_UINT256) invalid(label); }
function scope(value: EvmScope): void { uint256(value.chainId, "chainId"); }
function hex(value: string): string { return value.toLowerCase(); }
function optionalUint256(value: string | undefined, label: string): void { if (value !== undefined) uint256(value, label); }
function assertSameScope(expected: EvmScope, actual: EvmScope): void {
  if (actual.accountId !== expected.accountId || actual.chainId !== expected.chainId) invalid("response account or network does not match the request");
}
function assertSameIdentity(expected: EvmEffectIdentity, actual: EvmEffectIdentity): void {
  assertSameScope(expected, actual);
  if (actual.requestId !== expected.requestId) invalid("response request ID does not match the request");
}

export function parseEvmBalancesRequest(value: unknown): EvmBalancesRequest {
  const request = parseShape<EvmBalancesRequest>(value, evmBalancesInputSchema, "balance request");
  scope(request); request.tokens = request.tokens.map(hex);
  if (new Set(request.tokens).size !== request.tokens.length) invalid("duplicate requested token");
  return request;
}
export function parseEvmReadContractRequest(value: unknown): EvmReadContractRequest {
  const request = parseShape<EvmReadContractRequest>(value, evmReadContractInputSchema, "contract read request");
  scope(request); request.to = hex(request.to); request.data = hex(request.data);
  return request;
}
export function parseEvmCallContractRequest(value: unknown): EvmCallContractRequest {
  const request = parseShape<EvmCallContractRequest>(value, evmCallContractInputSchema, "contract call request");
  scope(request); request.to = hex(request.to); request.data = hex(request.data);
  if (request.blockTag !== undefined && request.blockTag !== "latest") request.blockTag = BigInt(request.blockTag).toString();
  return request;
}
export function parseEvmEstimateTransactionRequest(value: unknown): EvmEstimateTransactionRequest {
  const request = parseShape<EvmEstimateTransactionRequest>(value, evmEstimateTransactionInputSchema, "transaction estimate request");
  scope(request); uint256(request.valueWei, "estimated transaction value");
  request.to = hex(request.to); request.data = hex(request.data);
  return request;
}
export function parseEvmSendTransactionRequest(value: unknown): EvmSendTransactionRequest {
  const request = parseShape<EvmSendTransactionRequest>(value, evmSendTransactionInputSchema, "transaction request");
  scope(request); uint256(request.valueWei, "valueWei");
  for (const key of ["gasLimit", "maxFeePerGasWei", "maxPriorityFeePerGasWei", "gasPriceWei"] as const) optionalUint256(request[key], key);
  const dynamic = request.maxFeePerGasWei !== undefined || request.maxPriorityFeePerGasWei !== undefined;
  if (request.gasPriceWei !== undefined && (dynamic || request.transactionType === "eip1559")) invalid("mixed legacy and EIP-1559 fees");
  if (request.transactionType === "legacy" && dynamic) invalid("EIP-1559 fees on a legacy transaction");
  if ((request.transactionType === "legacy" || request.gasPriceWei !== undefined) && (request.accessList?.length ?? 0) !== 0) invalid("access list requires EIP-1559 transaction support");
  if (request.maxFeePerGasWei !== undefined && request.maxPriorityFeePerGasWei !== undefined && BigInt(request.maxPriorityFeePerGasWei) > BigInt(request.maxFeePerGasWei)) invalid("priority fee exceeds maximum fee");
  request.to = hex(request.to); request.data = hex(request.data);
  if (request.accessList !== undefined) request.accessList = request.accessList.map((entry) => ({ address: hex(entry.address), storageKeys: entry.storageKeys.map(hex) }));
  return request;
}
export function parseEvmReplaceTransactionRequest(value: unknown): EvmReplaceTransactionRequest {
  const request = parseShape<EvmReplaceTransactionRequest>(value, evmReplaceTransactionInputSchema, "replacement request");
  scope(request); uint256(request.maxFeePerGasWei, "replacement maximum fee"); uint256(request.maxPriorityFeePerGasWei, "replacement priority fee");
  if (BigInt(request.maxPriorityFeePerGasWei) > BigInt(request.maxFeePerGasWei)) invalid("replacement priority fee exceeds maximum fee");
  return request;
}
export function parseEvmSignMessageRequest(value: unknown): EvmSignMessageRequest {
  const request = parseShape<EvmSignMessageRequest>(value, evmSignMessageInputSchema, "message request");
  scope(request); request.messageHex = hex(request.messageHex); return request;
}
export function parseEvmSignTypedDataRequest(value: unknown): EvmSignTypedDataRequest {
  const request = parseShape<EvmSignTypedDataRequest>(value, evmSignTypedDataInputSchema, "typed-data request");
  scope(request);
  let parsed: unknown;
  try { parsed = JSON.parse(request.typedDataJson); } catch { invalid("typed-data JSON syntax"); }
  // This parse checks only structure. Do not derive chain IDs, uint256 values,
  // hashes, or reviewed display text from rounded JavaScript JSON numbers.
  const object = record(parsed, "typed-data object");
  const fields = ["types", "primaryType", "domain", "message"];
  if (Object.keys(object).length !== fields.length || fields.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) invalid("typed-data fields");
  record(object.types, "typed-data types"); record(object.domain, "typed-data domain"); record(object.message, "typed-data message");
  if (typeof object.primaryType !== "string" || !object.primaryType) invalid("typed-data primaryType");
  return request;
}
export function parseEvmOperationStatusRequest(value: unknown): EvmOperationStatusRequest {
  const request = parseShape<EvmOperationStatusRequest>(value, evmOperationStatusInputSchema, "operation-status request");
  scope(request); return request;
}
export function parseEvmEffectRequest(kind: "transaction", value: unknown): EvmSendTransactionRequest;
export function parseEvmEffectRequest(kind: "message", value: unknown): EvmSignMessageRequest;
export function parseEvmEffectRequest(kind: "typed_data", value: unknown): EvmSignTypedDataRequest;
export function parseEvmEffectRequest(kind: EvmEffectKind, value: unknown): EvmEffectRequest;
export function parseEvmEffectRequest(kind: EvmEffectKind, value: unknown): EvmEffectRequest {
  switch (kind) {
    case "transaction": return parseEvmSendTransactionRequest(value);
    case "message": return parseEvmSignMessageRequest(value);
    case "typed_data": return parseEvmSignTypedDataRequest(value);
    default: return invalid("effect kind");
  }
}

export function parseEvmAccountsResult(value: unknown): EvmAccountsResult {
  const result = parseShape<EvmAccountsResult>(value, evmAccountsOutputSchema, "accounts result");
  if (new Set(result.accounts.map((account) => account.accountId)).size !== result.accounts.length) invalid("duplicate account ID");
  for (const account of result.accounts) {
    account.address = hex(account.address); account.publicKey = hex(account.publicKey); account.keyFingerprint = hex(account.keyFingerprint);
  }
  return result;
}
export function parseEvmNetworksResult(value: unknown): EvmNetworksResult {
  const result = parseShape<EvmNetworksResult>(value, evmNetworksOutputSchema, "networks result");
  if (new Set(result.networks.map((network) => network.chainId)).size !== result.networks.length) invalid("duplicate network ID");
  for (const network of result.networks) {
    uint256(network.chainId, "network chainId");
    if (BigInt(network.nativeDecimals) > 255n) invalid("native decimals");
    let url: URL; try { url = new URL(network.explorerUrl); } catch { invalid("explorer URL"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") invalid("explorer URL protocol");
  }
  return result;
}
export function parseEvmBalancesResult(value: unknown, expected?: EvmBalancesRequest): EvmBalancesResult {
  const result = parseShape<EvmBalancesResult>(value, evmBalancesOutputSchema, "balance result");
  scope(result); uint256(result.nativeBalanceWei, "native balance"); result.address = hex(result.address);
  for (const token of result.tokens) {
    token.address = hex(token.address);
    if (token.balanceAtoms !== null) uint256(token.balanceAtoms, "token balance");
    if (token.decimals !== null && BigInt(token.decimals) > 255n) invalid("token decimals");
    if (token.balanceAtoms === null && token.error === null) invalid("missing token balance has no error");
  }
  if (new Set(result.tokens.map((token) => token.address)).size !== result.tokens.length) invalid("duplicate returned token");
  if (expected) {
    const request = parseEvmBalancesRequest(expected); assertSameScope(request, result);
    const returned = new Set(result.tokens.map((token) => token.address));
    if (request.tokens.length !== returned.size || request.tokens.some((token) => !returned.has(token))) invalid("returned tokens do not match the request");
  }
  return result;
}
export function parseEvmReadContractResult(value: unknown, expected?: EvmReadContractRequest): EvmReadContractResult {
  const result = parseShape<EvmReadContractResult>(value, evmReadContractOutputSchema, "contract read result");
  scope(result); result.address = hex(result.address); result.to = hex(result.to); result.data = hex(result.data); result.result = hex(result.result); result.code = hex(result.code);
  if (expected) {
    const request = parseEvmReadContractRequest(expected); assertSameScope(request, result);
    if (request.to !== result.to || request.data !== result.data) invalid("contract read response does not match the request");
  }
  return result;
}
export function parseEvmCallContractResult(value: unknown, expected?: EvmCallContractRequest): EvmCallContractResult {
  const result = parseShape<EvmCallContractResult>(value, evmCallContractOutputSchema, "contract call result");
  scope(result); result.address = hex(result.address); result.to = hex(result.to); result.data = hex(result.data); result.result = hex(result.result);
  if (expected) {
    const request = parseEvmCallContractRequest(expected); assertSameScope(request, result);
    if (request.to !== result.to || request.data !== result.data) invalid("contract call response does not match the request");
    if (request.blockTag !== undefined && request.blockTag !== "latest" && request.blockTag !== result.blockNumber) invalid("contract call response block does not match the request");
  }
  return result;
}
export function parseEvmEstimateTransactionResult(value: unknown, expected?: EvmEstimateTransactionRequest): EvmEstimateTransactionResult {
  const result = parseShape<EvmEstimateTransactionResult>(value, evmEstimateTransactionOutputSchema, "transaction estimate result");
  scope(result); uint256(result.valueWei, "estimated transaction value");
  result.address = hex(result.address); result.to = hex(result.to); result.data = hex(result.data);
  for (const key of ["gasLimit", "gasPriceWei", "baseFeePerGasWei", "maxPriorityFeePerGasWei", "maxFeePerGasWei"] as const) {
    if (result[key] !== null) uint256(result[key], key);
  }
  const available = result.status === "available";
  if (available !== (result.estimatedFeeWei !== null) || available === (result.feeBasis === "unavailable")) invalid("estimate status and fee evidence disagree");
  if (!available && !result.reasons.some((reason) => reason.length !== 0)) invalid("unavailable estimate has no reason");
  if (available) {
    if (result.gasLimit === null) invalid("available estimate has no gas estimate");
    let price: bigint;
    switch (result.feeBasis) {
      case "base_fee_plus_priority":
        if (result.baseFeePerGasWei === null || result.maxPriorityFeePerGasWei === null) invalid("estimate has no base or priority fee");
        price = BigInt(result.baseFeePerGasWei) + BigInt(result.maxPriorityFeePerGasWei); break;
      case "gas_price":
        if (result.gasPriceWei === null) invalid("estimate has no gas price");
        price = BigInt(result.gasPriceWei); break;
      case "arbitrum_total_gas": {
        const observedPrice = result.gasPriceWei ?? result.baseFeePerGasWei;
        if (observedPrice === null || result.postingCosts !== "included") invalid("Arbitrum estimate has no total gas price or posting evidence");
        price = BigInt(observedPrice); break;
      }
      default: return invalid("available estimate has no price basis");
    }
    // Products are arbitrary-precision decimal amounts, not rounded JS numbers.
    if (BigInt(result.estimatedFeeWei!) !== BigInt(result.gasLimit) * price) invalid("estimated fee does not match gas and price evidence");
  }
  if (result.maximumFeeWei !== null) {
    if (result.gasLimit === null || result.maxFeePerGasWei === null || BigInt(result.maximumFeeWei) !== BigInt(result.gasLimit) * BigInt(result.maxFeePerGasWei)) invalid("maximum fee does not match gas and price evidence");
  }
  if (expected) {
    const request = parseEvmEstimateTransactionRequest(expected); assertSameScope(request, result);
    if (request.to !== result.to || request.valueWei !== result.valueWei || request.data !== result.data) invalid("transaction estimate does not match the request");
  }
  return result;
}
export function parseEvmReceipt(value: unknown): EvmReceipt {
  const receipt = parseShape<EvmReceipt>(value, evmReceiptSchema, "receipt");
  receipt.blockHash = hex(receipt.blockHash); uint256(receipt.gasUsed, "gas used"); uint256(receipt.effectiveGasPriceWei, "effective gas price");
  for (const log of receipt.logs) { log.address = hex(log.address); log.data = hex(log.data); log.topics = log.topics.map(hex); }
  if (new Set(receipt.logs.map((log) => log.logIndex)).size !== receipt.logs.length) invalid("duplicate receipt log index");
  return receipt;
}
export function parseEvmOperationResult(value: unknown, expected?: EvmEffectIdentity, kind?: EvmEffectKind): EvmOperationResult {
  const result = parseShape<EvmOperationResult>(value, evmOperationOutputSchema, "operation result");
  scope(result); result.address = hex(result.address);
  if (result.transactionHash !== null) result.transactionHash = hex(result.transactionHash);
  if (result.replacementTransactionHash != null) result.replacementTransactionHash = hex(result.replacementTransactionHash);
  if (result.signature !== null) result.signature = hex(result.signature);
  if (result.receipt !== null) result.receipt = parseEvmReceipt(result.receipt);
  if (expected) assertSameIdentity(expected, result);
  if (kind && result.kind !== kind) invalid("operation kind does not match the request");
  if (result.kind !== "transaction") {
    if (result.transactionHash !== null || result.replacementTransactionHash != null || result.receipt !== null) invalid("message signature contains transaction evidence");
    if ((result.status === "signed" || result.status === "confirmed") && result.signature === null) invalid("completed message operation has no signature");
    if (["submitted", "reverted", "replaced"].includes(result.status)) invalid("transaction state on a message operation");
  } else {
    if (["signed", "submitted", "confirmed", "reverted", "replaced"].includes(result.status) && result.transactionHash === null) invalid("transaction state has no hash");
    if (result.status === "replaced" && (result.replacementTransactionHash == null || result.receipt !== null)) invalid("replaced transaction has no replacement hash or retains an original receipt");
    if (result.replacementTransactionHash != null && result.replacementTransactionHash === result.transactionHash) invalid("transaction cannot replace itself");
    if (result.status === "confirmed" && result.receipt?.status !== "success") invalid("confirmed transaction has no successful receipt");
    if (result.status === "reverted" && result.receipt?.status !== "reverted") invalid("reverted transaction has no reverted receipt");
    if (result.receipt !== null && result.transactionHash === null) invalid("receipt has no transaction hash");
  }
  return result;
}
export function parseEvmOperationStatusResult(value: unknown, expected?: EvmEffectIdentity): EvmOperationStatusResult {
  if (record(value, "operation status").status === "not_found") {
    const result = parseShape<EvmOperationNotFound>(value, (evmOperationStatusOutputSchema.oneOf as JsonObject[])[1]!, "missing operation");
    scope(result); if (expected) assertSameIdentity(expected, result); return result;
  }
  return parseEvmOperationResult(value, expected);
}

/** Caller identity comes only from Kernel context, never effect arguments. */
export function requireEvmWalletCaller(context: Pick<MsgBusToolContext, "caller" | "audience">, root = false): EvmWalletCaller {
  if (root && context.audience !== "agent_root") throw new EvmWalletProtocolError("EVM Wallet root effects require Kernel root-agent attestation");
  const caller = context.caller;
  if (!caller || typeof caller.appId !== "string" || !caller.appId || !isMsgBusInstallationUid(caller.installationUid)) {
    throw new EvmWalletProtocolError("EVM Wallet requires Kernel-authenticated caller installation identity");
  }
  return { appId: caller.appId, installationUid: caller.installationUid };
}

export function createEvmRequestId(fill: (bytes: Uint8Array) => void = (bytes) => crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>)): string {
  const bytes = new Uint8Array(16); fill(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Never serializes an already-rounded JavaScript number as an intended uint256. */
export function serializeEvmTypedData(value: unknown): string {
  const result = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isSafeInteger(entry)) invalid("unsafe number in typed data; use a decimal string or original JSON text");
    if (typeof entry === "bigint") return entry.toString();
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") invalid("non-JSON typed data");
    return entry;
  });
  if (result === undefined) invalid("typed data");
  parseEvmSignTypedDataRequest({ requestId: "0".repeat(32), accountId: "main", chainId: "1", typedDataJson: result });
  return result;
}

export type EvmWalletCallOptions = Pick<MsgBusCallOptions, "timeout" | "onProgress" | "signal">;
export type EvmWalletClientOptions = {
  /** Transport options only; caller authority is supplied by the injected client. */
  callOptions?: EvmWalletCallOptions;
};
export class EvmWalletClient {
  constructor(private readonly kernel: Pick<MsgBusClient, "callTool">, private readonly options: EvmWalletClientOptions = {}) {}
  private async invoke(name: string, args: object, options?: EvmWalletCallOptions): Promise<JsonValue> {
    const merged = { ...this.options.callOptions, ...options };
    // Transport authority is not a consumer option. Preserve the injected
    // invocation-scoped client and forward only cancellation/progress/timing.
    const callOptions: EvmWalletCallOptions = {};
    if (merged.timeout !== undefined) callOptions.timeout = merged.timeout;
    if (merged.onProgress !== undefined) callOptions.onProgress = merged.onProgress;
    if (merged.signal !== undefined) callOptions.signal = merged.signal;
    return this.kernel.callTool({ target: EVM_WALLET_TARGET, name, arguments: args as JsonObject }, callOptions);
  }
  async discover(options?: EvmWalletCallOptions): Promise<EvmAccountsResult & EvmNetworksResult> {
    const [accounts, networks] = await Promise.all([this.accounts(options), this.networks(options)]);
    return { ...accounts, ...networks };
  }
  async accounts(options?: EvmWalletCallOptions): Promise<EvmAccountsResult> {
    return parseEvmAccountsResult(await this.invoke(EVM_WALLET_TOOLS.accounts, {}, options));
  }
  async networks(options?: EvmWalletCallOptions): Promise<EvmNetworksResult> {
    return parseEvmNetworksResult(await this.invoke(EVM_WALLET_TOOLS.networks, {}, options));
  }
  async balances(value: EvmBalancesRequest, options?: EvmWalletCallOptions): Promise<EvmBalancesResult> {
    const request = parseEvmBalancesRequest(value);
    return parseEvmBalancesResult(await this.invoke(EVM_WALLET_TOOLS.balances, request, options), request);
  }
  async readContract(value: EvmReadContractRequest, options?: EvmWalletCallOptions): Promise<EvmReadContractResult> {
    const request = parseEvmReadContractRequest(value);
    return parseEvmReadContractResult(await this.invoke(EVM_WALLET_TOOLS.readContract, request, options), request);
  }
  async callContract(value: EvmCallContractRequest, options?: EvmWalletCallOptions): Promise<EvmCallContractResult> {
    const request = parseEvmCallContractRequest(value);
    return parseEvmCallContractResult(await this.invoke(EVM_WALLET_TOOLS.callContract, request, options), request);
  }
  async estimateTransaction(value: EvmEstimateTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmEstimateTransactionResult> {
    const request = parseEvmEstimateTransactionRequest(value);
    return parseEvmEstimateTransactionResult(await this.invoke(EVM_WALLET_TOOLS.estimateTransaction, request, options), request);
  }
  async sendTransaction(value: EvmSendTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    return this.effect("transaction", EVM_WALLET_TOOLS.sendTransaction, value, options);
  }
  async replaceTransaction(value: EvmReplaceTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    const request = parseEvmReplaceTransactionRequest(value);
    return parseEvmOperationResult(await this.invoke(EVM_WALLET_TOOLS.replaceTransaction, request, options), request, "transaction");
  }
  async replaceTransactionRoot(value: EvmReplaceTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    const request = parseEvmReplaceTransactionRequest(value);
    return parseEvmOperationResult(await this.invoke(EVM_WALLET_TOOLS.replaceTransactionRoot, request, options), request, "transaction");
  }
  async signMessage(value: EvmSignMessageRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    return this.effect("message", EVM_WALLET_TOOLS.signMessage, value, options);
  }
  async signTypedData(value: EvmSignTypedDataRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    return this.effect("typed_data", EVM_WALLET_TOOLS.signTypedData, value, options);
  }
  /** This method cannot grant root authority; the provider checks Kernel attestation. */
  async sendTransactionRoot(value: EvmSendTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    return this.effect("transaction", EVM_WALLET_TOOLS.sendTransactionRoot, value, options);
  }
  async signMessageRoot(value: EvmSignMessageRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    return this.effect("message", EVM_WALLET_TOOLS.signMessageRoot, value, options);
  }
  async signTypedDataRoot(value: EvmSignTypedDataRequest, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    return this.effect("typed_data", EVM_WALLET_TOOLS.signTypedDataRoot, value, options);
  }
  private async effect(kind: EvmEffectKind, name: string, value: unknown, options?: EvmWalletCallOptions): Promise<EvmOperationResult> {
    const request = parseEvmEffectRequest(kind, value);
    return parseEvmOperationResult(await this.invoke(name, request, options), request, kind);
  }
  async transaction(value: EvmTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmTransactionResult> {
    const request = parseEvmTransactionRequest(value);
    return parseEvmTransactionResult(await this.invoke(EVM_WALLET_TOOLS.transaction, request, options), request);
  }
  async replacementTransaction(value: EvmReplacementTransactionRequest, options?: EvmWalletCallOptions): Promise<EvmReplacementTransactionResult> {
    const request = parseEvmReplacementTransactionRequest(value);
    return parseEvmReplacementTransactionResult(await this.invoke(EVM_WALLET_TOOLS.replacementTransaction, request, options), request);
  }
  async operationStatus(value: EvmOperationStatusRequest, options?: EvmWalletCallOptions): Promise<EvmOperationStatusResult> {
    const request = parseEvmOperationStatusRequest(value);
    return parseEvmOperationStatusResult(await this.invoke(EVM_WALLET_TOOLS.operationStatus, request, options), request);
  }
}
export function createEvmWalletClient(kernel: Pick<MsgBusClient, "callTool">, options: EvmWalletClientOptions = {}): EvmWalletClient {
  return new EvmWalletClient(kernel, options);
}

/** A completed on-chain receipt can still be reorganized; consult its finality. */
export function evmOperationIsTerminal(result: EvmOperationStatusResult): boolean {
  if (result.status === "not_found") return false;
  return ["confirmed", "reverted", "rejected", "failed", "replaced"].includes(result.status) || (result.kind !== "transaction" && result.status === "signed");
}

/** Persist this complete record before an effect. Storage is owned by the consumer. */
export type EvmWalletIntent = {
  version: 1;
  kind: EvmEffectKind;
  request: EvmEffectRequest;
  walletAddress: string;
  walletKeyFingerprint: string;
};
export function parseEvmWalletIntent(value: unknown): EvmWalletIntent {
  const object = record(value, "saved intent");
  const keys = ["version", "kind", "request", "walletAddress", "walletKeyFingerprint"];
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key)) || object.version !== 1) invalid("saved intent fields");
  if (!["transaction", "message", "typed_data"].includes(object.kind as string)) invalid("saved intent kind");
  shape(object.walletAddress, ADDRESS, "saved wallet address"); shape(object.walletKeyFingerprint, HASH, "saved wallet fingerprint");
  const kind = object.kind as EvmEffectKind;
  return { version: 1, kind, request: parseEvmEffectRequest(kind, object.request), walletAddress: hex(object.walletAddress as string), walletKeyFingerprint: hex(object.walletKeyFingerprint as string) };
}
/**
 * Identity checks survive endpoint reloads but prevent replay against a replaced
 * wallet installation whose key has changed. No effect is invoked here.
 */
export async function prepareEvmWalletIntent(
  client: EvmWalletClient, kind: EvmEffectKind, value: EvmEffectRequest,
  persist: (intent: EvmWalletIntent) => Promise<void>,
): Promise<EvmWalletIntent> {
  const request = parseEvmEffectRequest(kind, value);
  const { accounts } = await client.accounts();
  const account = accounts.find((entry) => entry.accountId === request.accountId);
  if (!account) throw new EvmWalletProtocolError("Requested EVM Wallet account is unavailable");
  const intent = parseEvmWalletIntent({ version: 1, kind, request, walletAddress: account.address, walletKeyFingerprint: account.keyFingerprint });
  await persist(parseEvmWalletIntent(intent));
  return intent;
}
export async function assertEvmWalletIntentAccount(client: EvmWalletClient, value: EvmWalletIntent): Promise<EvmWalletIntent> {
  const intent = parseEvmWalletIntent(value);
  const { accounts } = await client.accounts();
  const account = accounts.find((entry) => entry.accountId === intent.request.accountId);
  if (!account || account.address !== intent.walletAddress || account.keyFingerprint !== intent.walletKeyFingerprint) {
    throw new EvmWalletProtocolError("EVM Wallet account identity changed; reconcile the saved operation with the original wallet before creating a new intent");
  }
  return intent;
}
/**
 * Reconcile an already persisted intent. A known operation is returned without
 * invoking an effect. Only a definitive not_found can submit the same request.
 * Transport failures propagate and never allocate a new request ID.
 */
export async function resumeEvmWalletIntent(client: EvmWalletClient, value: EvmWalletIntent): Promise<EvmOperationResult> {
  const intent = await assertEvmWalletIntentAccount(client, value);
  const request = intent.request;
  const status = await client.operationStatus({ requestId: request.requestId, accountId: request.accountId, chainId: request.chainId });
  if (status.status !== "not_found") {
    if (status.address !== intent.walletAddress || status.kind !== intent.kind) invalid("saved operation account or kind changed");
    return status;
  }
  let result: EvmOperationResult;
  switch (intent.kind) {
    case "transaction": result = await client.sendTransaction(request as EvmSendTransactionRequest); break;
    case "message": result = await client.signMessage(request as EvmSignMessageRequest); break;
    case "typed_data": result = await client.signTypedData(request as EvmSignTypedDataRequest); break;
  }
  if (result.address !== intent.walletAddress) invalid("effect account differs from the saved intent");
  return result;
}

/** Public chain evidence, independent of the installation that submitted it. */
export type EvmWalletRequestReference = { callerAppId: string; callerInstallationUid: string; requestId: string };
export type EvmTransactionRequest = { chainId: string; transactionHash: string; walletRequest?: EvmWalletRequestReference };
export type EvmTransaction = {
  from: string;
  to: string | null;
  data: string;
  valueWei: string;
  nonce: string;
  blockNumber: string | null;
  blockHash: string | null;
};
export type EvmTransactionResult = {
  chainId: string;
  transactionHash: string;
  /** A lookup of the wallet journal, not authority supplied by the requester. */
  walletRequestMatches: boolean | null;
  transaction: EvmTransaction | null;
  receipt: EvmReceipt | null;
  observedAtNs: string;
  source: "evm_rpc";
};
export const evmWalletRequestReferenceSchema = closedSchema({
  callerAppId: TEXT, callerInstallationUid: POSITIVE_UINT,
  requestId: { type: "string", pattern: "^[0-9a-f]{32}$" },
});
export const evmTransactionInputSchema = closedSchema({ chainId: POSITIVE_UINT, transactionHash: HASH, walletRequest: evmWalletRequestReferenceSchema }, ["walletRequest"]);
export const evmTransactionOutputSchema = closedSchema({
  chainId: POSITIVE_UINT, transactionHash: HASH,
  transaction: nullable(closedSchema({
    from: ADDRESS, to: nullable(ADDRESS), data: HEX, valueWei: UINT, nonce: UINT,
    blockNumber: nullable(UINT), blockHash: nullable(HASH),
  })),
  receipt: nullable(evmReceiptSchema), observedAtNs: UINT, source: { const: "evm_rpc" },
  walletRequestMatches: nullable({ type: "boolean" }),
});
export function parseEvmTransactionRequest(value: unknown): EvmTransactionRequest {
  const request = parseShape<EvmTransactionRequest>(value, evmTransactionInputSchema, "transaction evidence request");
  uint256(request.chainId, "chainId"); request.transactionHash = hex(request.transactionHash);
  if (request.walletRequest && (!request.walletRequest.callerAppId || !isMsgBusInstallationUid(request.walletRequest.callerInstallationUid))) invalid("wallet request reference");
  return request;
}
export function parseEvmTransactionResult(value: unknown, expected?: EvmTransactionRequest): EvmTransactionResult {
  const result = parseShape<EvmTransactionResult>(value, evmTransactionOutputSchema, "transaction evidence result");
  uint256(result.chainId, "chainId"); result.transactionHash = hex(result.transactionHash);
  const transaction = result.transaction;
  if (transaction !== null) {
    transaction.from = hex(transaction.from); transaction.to = transaction.to === null ? null : hex(transaction.to);
    transaction.data = hex(transaction.data); transaction.blockHash = transaction.blockHash === null ? null : hex(transaction.blockHash);
    uint256(transaction.valueWei, "transaction value"); uint256(transaction.nonce, "transaction nonce");
    if ((transaction.blockNumber === null) !== (transaction.blockHash === null)) invalid("transaction inclusion fields disagree");
  }
  if (result.receipt !== null) {
    result.receipt = parseEvmReceipt(result.receipt);
    if (!transaction || transaction.blockHash !== result.receipt.blockHash || transaction.blockNumber !== result.receipt.blockNumber) invalid("transaction and receipt inclusion disagree");
  }
  if (expected) {
    const request = parseEvmTransactionRequest(expected);
    if (request.chainId !== result.chainId || request.transactionHash !== result.transactionHash) invalid("transaction evidence does not match the request");
    if ((request.walletRequest === undefined) !== (result.walletRequestMatches === null)) invalid("wallet request binding result does not match the query");
  }
  return result;
}

/**
 * Read-only journal proof for a signed replacement descending from a saved
 * command. It does not establish inclusion or success: obtain the replacement's
 * public transaction and receipt separately with transaction().
 */
export type EvmReplacementTransactionRequest = {
  chainId: string;
  transactionHash: string;
  originalWalletRequest: EvmWalletRequestReference;
};
export type EvmReplacementTransactionResult = EvmReplacementTransactionRequest & {
  walletReplacementMatches: boolean;
  observedAtNs: string;
  source: "evm_wallet_journal";
};
export const evmReplacementTransactionInputSchema = closedSchema({
  chainId: POSITIVE_UINT, transactionHash: HASH, originalWalletRequest: evmWalletRequestReferenceSchema,
});
export const evmReplacementTransactionOutputSchema = closedSchema({
  chainId: POSITIVE_UINT, transactionHash: HASH, originalWalletRequest: evmWalletRequestReferenceSchema,
  walletReplacementMatches: { type: "boolean" }, observedAtNs: UINT, source: { const: "evm_wallet_journal" },
});
export function parseEvmReplacementTransactionRequest(value: unknown): EvmReplacementTransactionRequest {
  const request = parseShape<EvmReplacementTransactionRequest>(value, evmReplacementTransactionInputSchema, "replacement journal proof request");
  const checked = parseEvmTransactionRequest({ chainId: request.chainId, transactionHash: request.transactionHash, walletRequest: request.originalWalletRequest });
  return { chainId: checked.chainId, transactionHash: checked.transactionHash, originalWalletRequest: checked.walletRequest! };
}
export function parseEvmReplacementTransactionResult(value: unknown, expected?: EvmReplacementTransactionRequest): EvmReplacementTransactionResult {
  const result = parseShape<EvmReplacementTransactionResult>(value, evmReplacementTransactionOutputSchema, "replacement journal proof result");
  const identity = parseEvmReplacementTransactionRequest({ chainId: result.chainId, transactionHash: result.transactionHash, originalWalletRequest: result.originalWalletRequest });
  result.transactionHash = identity.transactionHash;
  if (expected) {
    const request = parseEvmReplacementTransactionRequest(expected);
    const original = result.originalWalletRequest;
    if (request.chainId !== result.chainId || request.transactionHash !== result.transactionHash ||
      request.originalWalletRequest.callerAppId !== original.callerAppId ||
      request.originalWalletRequest.callerInstallationUid !== original.callerInstallationUid ||
      request.originalWalletRequest.requestId !== original.requestId) invalid("replacement journal proof does not match the request");
  }
  return result;
}
