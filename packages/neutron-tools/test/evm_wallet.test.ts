import { expect, test } from "bun:test";
import * as evm from "../src/evm_wallet.ts";
import { normalizeToolDescriptor } from "../src/protocol.ts";
import {
  createEvmRequestId,
  createEvmWalletClient,
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
  EvmWalletProtocolError,
  evmOperationIsTerminal,
  parseEvmAccountsResult,
  parseEvmBalancesRequest,
  parseEvmBalancesResult,
  parseEvmEffectRequest,
  parseEvmEstimateTransactionRequest,
  parseEvmEstimateTransactionResult,
  parseEvmNetworksResult,
  parseEvmOperationResult,
  parseEvmOperationStatusRequest,
  parseEvmOperationStatusResult,
  parseEvmReadContractRequest,
  parseEvmReadContractResult,
  parseEvmReplaceTransactionRequest,
  parseEvmReplacementTransactionRequest,
  parseEvmReplacementTransactionResult,
  parseEvmReceipt,
  parseEvmSendTransactionRequest,
  parseEvmSignMessageRequest,
  parseEvmSignTypedDataRequest,
  parseEvmTransactionRequest,
  parseEvmTransactionResult,
  parseEvmWalletIntent,
  prepareEvmWalletIntent,
  requireEvmWalletCaller,
  resumeEvmWalletIntent,
  serializeEvmTypedData,
  type EvmAccount,
  type EvmBalancesResult,
  type EvmEffectIdentity,
  type EvmEffectKind,
  type EvmEstimateTransactionRequest,
  type EvmEstimateTransactionResult,
  type EvmOperationResult,
  type EvmReadContractResult,
  type EvmReplaceTransactionRequest,
  type EvmReplacementTransactionRequest,
  type EvmReplacementTransactionResult,
  type EvmReceipt,
  type EvmSendTransactionRequest,
  type EvmWalletIntent,
  type EvmTransactionResult,
} from "../src/evm_wallet.ts";
import type {
  JsonValue,
  MsgBusCallOptions,
  MsgBusClient,
  MsgBusToolCall,
  MsgBusToolContext,
} from "../src/protocol.ts";

const ADDRESS = `0x${"ab".repeat(20)}`;
const TOKEN = `0x${"cd".repeat(20)}`;
const OTHER_ADDRESS = `0x${"ef".repeat(20)}`;
const HASH = `0x${"12".repeat(32)}`;
const FINGERPRINT = `0x${"34".repeat(32)}`;
const SIGNATURE = `0x${"56".repeat(65)}`;
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const OVER_UINT256 = (1n << 256n).toString();
const SCOPE = { accountId: "main" as const, chainId: "1" };
const IDENTITY = { ...SCOPE, requestId: "0123456789abcdef0123456789abcdef" };
const ACCOUNT: EvmAccount = {
  accountId: "main", address: ADDRESS, publicKey: `0x02${"78".repeat(32)}`,
  keyFingerprint: FINGERPRINT, namespaceVersion: "1",
};
const TYPED_DATA_JSON = `{
  "types": {"EIP712Domain": [{"name":"chainId","type":"uint256"}], "Permit": [{"name":"value","type":"uint256"}]},
  "primaryType": "Permit", "domain": {"chainId": 1},
  "message": {"value": 9007199254740993}
}`;

function transaction(patch: Partial<EvmSendTransactionRequest> = {}): EvmSendTransactionRequest {
  return { ...IDENTITY, to: TOKEN, valueWei: "0", data: "0xaabb", ...patch };
}

function replacement(patch: Partial<EvmReplaceTransactionRequest> = {}): EvmReplaceTransactionRequest {
  return { ...IDENTITY, operationId: "12", cancel: false, maxFeePerGasWei: "40000000000", maxPriorityFeePerGasWei: "2000000000", ...patch };
}

function receipt(patch: Partial<EvmReceipt> = {}): EvmReceipt {
  return {
    blockNumber: "100", blockHash: HASH, status: "success", gasUsed: "21000",
    effectiveGasPriceWei: "30000000000", logs: [{ address: TOKEN, data: "0x", topics: [HASH], logIndex: "0" }],
    finality: "included", observedAtNs: "1000000000", ...patch,
  };
}

function operation(patch: Partial<EvmOperationResult> = {}): EvmOperationResult {
  return {
    ...IDENTITY, operationId: "1", kind: "transaction", status: "submitted", address: ADDRESS,
    transactionHash: HASH, signature: null, message: null, reviewRevision: "1", receipt: null, ...patch,
  };
}

function balanceResult(patch: Partial<EvmBalancesResult> = {}): EvmBalancesResult {
  return {
    ...SCOPE, address: ADDRESS, nativeBalanceWei: "1000000000000000000",
    tokens: [{ address: TOKEN, balanceAtoms: "1000000", decimals: "6", symbol: "USDC", error: null }],
    blockNumber: "100", observedAtNs: "1000000000", completeness: "requested_only", ...patch,
  };
}

function readResult(patch: Partial<EvmReadContractResult> = {}): EvmReadContractResult {
  return { ...SCOPE, address: ADDRESS, to: TOKEN, data: "0xaabb", result: "0x1234", code: "0x6000", blockNumber: "100", observedAtNs: "1000000000", ...patch };
}

test("lightweight contract calls forward the exact requested block and reject mismatched observations", async () => {
  const { code: _, ...result } = readResult();
  const mock = transport(() => result);
  const request = { ...SCOPE, to: TOKEN, data: "0xaabb", blockTag: "0x64" };
  expect(await mock.client.callContract(request)).toEqual(result);
  expect(mock.calls[0]?.call).toEqual({ target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.callContract, arguments: { ...request, blockTag: "100" } });
  await expect(mock.client.callContract({ ...request, blockTag: "99" })).rejects.toThrow("block does not match");
  expect(() => evm.parseEvmCallContractRequest({ ...request, blockTag: "pending" })).toThrow();
  expect(() => evm.parseEvmCallContractResult(readResult(), request)).toThrow();
  expect(() => evm.parseEvmCallContractResult({ ...result, data: "0xbb" }, request)).toThrow("does not match");
});

function estimateRequest(patch: Partial<EvmEstimateTransactionRequest> = {}): EvmEstimateTransactionRequest {
  return { ...SCOPE, to: TOKEN, valueWei: "7", data: "0xaabb", ...patch };
}

function estimateResult(patch: Partial<EvmEstimateTransactionResult> = {}): EvmEstimateTransactionResult {
  return {
    ...estimateRequest(), address: ADDRESS, status: "available", gasLimit: "21000", gasPriceWei: "40",
    baseFeePerGasWei: "20", maxPriorityFeePerGasWei: "3", maxFeePerGasWei: "50", estimatedFeeWei: "483000",
    maximumFeeWei: "1050000", blockNumber: "100", observedAtNs: "1000000000",
    feeBasis: "base_fee_plus_priority", postingCosts: "not_applicable", reasons: [], source: "evm_rpc", ...patch,
  };
}

function chainEvidence(patch: Partial<EvmTransactionResult> = {}): EvmTransactionResult {
  return {
    chainId: "1", transactionHash: HASH, walletRequestMatches: null,
    transaction: { from: ADDRESS, to: TOKEN, data: "0xaabb", valueWei: "0", nonce: "10", blockNumber: "100", blockHash: HASH },
    receipt: receipt(), observedAtNs: "1000000000", source: "evm_rpc", ...patch,
  };
}

function replacementProofRequest(patch: Partial<EvmReplacementTransactionRequest> = {}): EvmReplacementTransactionRequest {
  return { chainId: "1", transactionHash: HASH, originalWalletRequest: { callerAppId: "uniswap", callerInstallationUid: "7", requestId: IDENTITY.requestId }, ...patch };
}

function replacementProof(patch: Partial<EvmReplacementTransactionResult> = {}): EvmReplacementTransactionResult {
  return { ...replacementProofRequest(), walletReplacementMatches: true, observedAtNs: "1000000000", source: "evm_wallet_journal", ...patch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type RecordedCall = { call: MsgBusToolCall; options: number | MsgBusCallOptions | undefined };
function transport(handler: (call: MsgBusToolCall) => unknown | Promise<unknown>) {
  const calls: RecordedCall[] = [];
  const kernel: Pick<MsgBusClient, "callTool"> = {
    async callTool<T extends JsonValue = JsonValue>(call: MsgBusToolCall, options?: number | MsgBusCallOptions): Promise<T> {
      calls.push({ call: structuredClone(call), options });
      return await handler(call) as T;
    },
  };
  return { calls, kernel, client: createEvmWalletClient(kernel) };
}

test("every exported wallet schema registers under the existing Kernel descriptor rules", () => {
  const schemas = Object.entries(evm).filter(([name]) => name.endsWith("Schema"));
  expect(schemas.length).toBeGreaterThan(15);
  for (const [name, value] of schemas) {
    const schema = value as import("../src/protocol.ts").JsonObject;
    expect(normalizeToolDescriptor({ name, inputSchema: evm.evmEmptyInputSchema, outputSchema: schema }).outputSchema).toEqual(schema);
    if (name.endsWith("InputSchema")) expect(normalizeToolDescriptor({ name, inputSchema: schema }).inputSchema).toEqual(schema);
  }
});

test("EVM requests are closed objects and cannot supply caller identity or signing authority", () => {
  const cases: Array<[(value: unknown) => unknown, Record<string, unknown>]> = [
    [parseEvmSendTransactionRequest, transaction()],
    [parseEvmSignMessageRequest, { ...IDENTITY, messageHex: "0x00ff" }],
    [parseEvmSignTypedDataRequest, { ...IDENTITY, typedDataJson: TYPED_DATA_JSON }],
    [parseEvmOperationStatusRequest, IDENTITY],
    [parseEvmBalancesRequest, { ...SCOPE, tokens: [TOKEN] }],
    [parseEvmReadContractRequest, { ...SCOPE, to: TOKEN, data: "0xaabb" }],
  ];
  for (const [parse, valid] of cases) {
    expect(() => parse(valid)).not.toThrow();
    for (const extra of [
      { caller: { appId: "agent", installationUid: "1" } },
      { installationUid: "1" }, { audience: "agent_root" }, { privateKey: "0x00" }, { namespace: "evm_wallet" },
    ]) expect(() => parse({ ...valid, ...extra })).toThrow(EvmWalletProtocolError);
    for (const malformed of [null, [], "request", Object.create(valid)]) expect(() => parse(malformed)).toThrow(EvmWalletProtocolError);
    for (const key of Object.keys(valid)) {
      const missing = { ...valid }; delete missing[key];
      expect(() => parse(missing)).toThrow(EvmWalletProtocolError);
    }
  }
});

test("atomic quantities and chain IDs preserve uint256 precision and reject ambiguous decimal strings", () => {
  const request = transaction({ chainId: MAX_UINT256, valueWei: MAX_UINT256, gasLimit: MAX_UINT256, gasPriceWei: MAX_UINT256 });
  expect(parseEvmSendTransactionRequest(request)).toEqual(request);
  for (const value of ["", "00", "01", "-1", "+1", "1.0", "1e9", " 1", "1 ", "1\n", "1\r\n", "0x01", OVER_UINT256, 1, 1n]) {
    for (const key of ["chainId", "valueWei", "gasLimit", "gasPriceWei", "maxFeePerGasWei", "maxPriorityFeePerGasWei"]) {
      expect(() => parseEvmSendTransactionRequest({ ...transaction(), [key]: value })).toThrow(EvmWalletProtocolError);
    }
  }
  expect(() => parseEvmSendTransactionRequest(transaction({ chainId: "0" }))).toThrow();
  expect(() => parseEvmSendTransactionRequest(transaction({ gasLimit: "0" }))).toThrow();
  expect(parseEvmSendTransactionRequest(transaction({ gasPriceWei: "0" })).gasPriceWei).toBe("0");
  for (const requestId of ["0".repeat(31), "0".repeat(33), "A".repeat(32), "g".repeat(32), `${IDENTITY.requestId}\n`]) {
    expect(() => parseEvmOperationStatusRequest({ ...IDENTITY, requestId })).toThrow();
  }
});

test("transaction fee modes, addresses and access lists are checked before transport", () => {
  for (const fees of [
    { transactionType: "eip1559", gasPriceWei: "10" },
    { transactionType: "legacy", maxFeePerGasWei: "10" },
    { gasPriceWei: "10", maxPriorityFeePerGasWei: "1" },
    { maxFeePerGasWei: "10", maxPriorityFeePerGasWei: "11" },
    { transactionType: "legacy", accessList: [{ address: TOKEN, storageKeys: [HASH] }] },
  ]) expect(() => parseEvmSendTransactionRequest({ ...transaction(), ...fees })).toThrow(EvmWalletProtocolError);
  for (const to of ["0x", "0x1234", `0x${"zz".repeat(20)}`, `${TOKEN}\n`]) expect(() => parseEvmSendTransactionRequest({ ...transaction(), to })).toThrow();
  for (const data of ["", "0x1", "0xgg", "0X00"]) expect(() => parseEvmSendTransactionRequest({ ...transaction(), data })).toThrow();
  expect(() => parseEvmSendTransactionRequest({ ...transaction(), accessList: [{ address: TOKEN, storageKeys: [HASH], caller: "agent" }] })).toThrow();
  expect(() => parseEvmSendTransactionRequest({ ...transaction(), accessList: [{ address: TOKEN, storageKeys: ["0x00"] }] })).toThrow();
  const request = transaction({ to: `0x${"AB".repeat(20)}`, data: "0xAABB", accessList: [{ address: `0x${"CD".repeat(20)}`, storageKeys: [`0x${"EF".repeat(32)}`] }] });
  const parsed = parseEvmSendTransactionRequest(request);
  expect(parsed).toMatchObject({ to: ADDRESS, data: "0xaabb", accessList: [{ address: TOKEN, storageKeys: [`0x${"ef".repeat(32)}`] }] });
  parsed.accessList![0]!.storageKeys.push(HASH);
  expect(request.accessList![0]!.storageKeys).toHaveLength(1);
});

test("replacement requests identify the original operation and require an explicit boolean cancellation decision", () => {
  for (const cancel of [true, false]) expect(parseEvmReplaceTransactionRequest(replacement({ cancel }))).toEqual(replacement({ cancel }));
  for (const cancel of ["true", "false", 0, 1, null, undefined, {}, []]) {
    expect(() => parseEvmReplaceTransactionRequest({ ...replacement(), cancel })).toThrow(EvmWalletProtocolError);
  }
  const valid = replacement();
  for (const key of Object.keys(valid)) {
    const missing = { ...valid } as Record<string, unknown>; delete missing[key];
    expect(() => parseEvmReplaceTransactionRequest(missing)).toThrow(EvmWalletProtocolError);
  }
  for (const extra of [{ caller: { appId: "agent", installationUid: "1" } }, { audience: "agent_root" }, { to: OTHER_ADDRESS }, { valueWei: "1" }, { data: "0x00" }, { nonce: "9" }, { gasPriceWei: "100" }]) {
    expect(() => parseEvmReplaceTransactionRequest({ ...valid, ...extra })).toThrow(EvmWalletProtocolError);
  }
  const parsed = parseEvmReplaceTransactionRequest(valid);
  parsed.cancel = true;
  expect(valid.cancel).toBe(false);
});

test("replacement operation IDs and fees remain exact decimal values and reject inconsistent fee settings", () => {
  const precise = replacement({ operationId: "9007199254740993", maxFeePerGasWei: MAX_UINT256, maxPriorityFeePerGasWei: MAX_UINT256 });
  expect(parseEvmReplaceTransactionRequest(precise)).toEqual(precise);
  expect(parseEvmReplaceTransactionRequest(replacement({ operationId: "0", maxFeePerGasWei: "0", maxPriorityFeePerGasWei: "0" })).operationId).toBe("0");
  for (const value of ["", "00", "01", "-1", "+1", "1.0", "1e9", " 1", "1 ", "1\n", "1\r\n", "0x01", 1, 1n]) {
    for (const key of ["operationId", "maxFeePerGasWei", "maxPriorityFeePerGasWei"]) {
      expect(() => parseEvmReplaceTransactionRequest({ ...replacement(), [key]: value })).toThrow(EvmWalletProtocolError);
    }
  }
  for (const patch of [{ chainId: OVER_UINT256 }, { chainId: "0" }, { maxFeePerGasWei: OVER_UINT256 }, { maxPriorityFeePerGasWei: OVER_UINT256 }, { maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "2" }]) {
    expect(() => parseEvmReplaceTransactionRequest({ ...replacement(), ...patch })).toThrow(EvmWalletProtocolError);
  }
});

test("typed data carries original JSON bytes beyond Number precision without parse-and-reserialize", () => {
  const parsed = parseEvmSignTypedDataRequest({ ...IDENTITY, typedDataJson: TYPED_DATA_JSON });
  expect(parsed.typedDataJson).toBe(TYPED_DATA_JSON);
  expect(parsed.typedDataJson).toContain("9007199254740993");
  expect(JSON.stringify(JSON.parse(TYPED_DATA_JSON))).toContain("9007199254740992");
  for (const typedDataJson of ["{", "null", "[]", "{}", '{"types":{},"primaryType":"","domain":{},"message":{}}', '{"types":{},"primaryType":"Permit","domain":{},"message":{},"caller":"agent"}']) {
    expect(() => parseEvmSignTypedDataRequest({ ...IDENTITY, typedDataJson })).toThrow(EvmWalletProtocolError);
  }
});

test("typed-data serializer requires exact integer values and keeps bigint as decimal text", () => {
  const data = { types: {}, primaryType: "Permit", domain: { chainId: 1 }, message: { value: 9007199254740993n } };
  expect(JSON.parse(serializeEvmTypedData(data)).message.value).toBe("9007199254740993");
  for (const value of [9007199254740992, Infinity, NaN, 0.5, undefined, () => 1, Symbol("amount")]) {
    expect(() => serializeEvmTypedData({ ...data, message: { value } })).toThrow(EvmWalletProtocolError);
  }
});

test("account and network discovery rejects ambiguous or untrusted result metadata", () => {
  expect(parseEvmAccountsResult({ accounts: [ACCOUNT] })).toEqual({ accounts: [ACCOUNT] });
  expect(() => parseEvmAccountsResult({ accounts: [ACCOUNT, ACCOUNT] })).toThrow("duplicate account");
  expect(() => parseEvmAccountsResult({ accounts: [{ ...ACCOUNT, privateKey: "0x00" }] })).toThrow();
  expect(() => parseEvmAccountsResult({ accounts: [{ ...ACCOUNT, publicKey: `0x05${"78".repeat(32)}` }] })).toThrow();
  const network = { chainId: "1", name: "Ethereum", nativeSymbol: "ETH", nativeDecimals: "18", explorerUrl: "https://etherscan.io", feeModel: "eip1559" as const, finalityKind: "ethereum" as const };
  expect(parseEvmNetworksResult({ networks: [network] }).networks[0]).toEqual(network);
  expect(() => parseEvmNetworksResult({ networks: [network, network] })).toThrow("duplicate network");
  for (const patch of [{ chainId: OVER_UINT256 }, { nativeDecimals: "256" }, { explorerUrl: "javascript:alert(1)" }, { rpcSecret: "hidden" }]) {
    expect(() => parseEvmNetworksResult({ networks: [{ ...network, ...patch }] })).toThrow();
  }
});

test("balances are scoped to the exact requested token set and preserve partial errors", () => {
  const request = { ...SCOPE, tokens: [TOKEN] };
  expect(parseEvmBalancesResult(balanceResult(), request)).toEqual(balanceResult());
  expect(() => parseEvmBalancesRequest({ ...SCOPE, tokens: [TOKEN, `0x${"CD".repeat(20)}`] })).toThrow("duplicate requested token");
  for (const patch of [
    { chainId: "42161" }, { tokens: [] }, { tokens: [...balanceResult().tokens, ...balanceResult().tokens] },
    { tokens: [{ ...balanceResult().tokens[0]!, address: OTHER_ADDRESS }] }, { nativeBalanceWei: OVER_UINT256 },
    { tokens: [{ ...balanceResult().tokens[0]!, balanceAtoms: null }] },
    { tokens: [{ ...balanceResult().tokens[0]!, decimals: "256" }] },
    { tokens: [{ ...balanceResult().tokens[0]!, balanceAtoms: OVER_UINT256 }] },
    { providerApiKey: "secret" },
  ]) expect(() => parseEvmBalancesResult({ ...balanceResult(), ...patch }, request)).toThrow(EvmWalletProtocolError);
  const partial = balanceResult({ tokens: [{ address: TOKEN, balanceAtoms: null, decimals: null, symbol: null, error: "RPC unavailable" }] });
  expect(parseEvmBalancesResult(partial, request).tokens[0]!.error).toBe("RPC unavailable");
});

test("contract-read responses bind account, network, destination and exact calldata", () => {
  const request = { ...SCOPE, to: TOKEN, data: "0xaabb" };
  expect(parseEvmReadContractResult(readResult(), request)).toEqual(readResult());
  for (const patch of [{ chainId: "42161" }, { to: OTHER_ADDRESS }, { data: "0xaabc" }, { result: "0x1" }, { code: "0x1" }, { caller: "agent" }]) {
    expect(() => parseEvmReadContractResult({ ...readResult(), ...patch }, request)).toThrow(EvmWalletProtocolError);
  }
});

test("transaction estimates accept only an exact read request, without transaction authority or fee authorization", () => {
  const request = estimateRequest({ chainId: MAX_UINT256, valueWei: MAX_UINT256, to: `0x${"CD".repeat(20)}`, data: "0xAABB" });
  expect(parseEvmEstimateTransactionRequest(request)).toEqual({ ...request, to: TOKEN, data: "0xaabb" });
  for (const patch of [
    { chainId: "0" }, { chainId: OVER_UINT256 }, { valueWei: "01" }, { valueWei: OVER_UINT256 }, { valueWei: "1\n" },
    { data: "0xa" }, { requestId: IDENTITY.requestId }, { maxFeePerGasWei: "50" }, { gasLimit: "21000" },
    { audience: "agent_root" }, { caller: { appId: "agent", installationUid: "1" } },
  ]) expect(() => parseEvmEstimateTransactionRequest({ ...estimateRequest(), ...patch })).toThrow(EvmWalletProtocolError);
  for (const key of Object.keys(estimateRequest())) {
    const missing = { ...estimateRequest() } as Record<string, unknown>; delete missing[key];
    expect(() => parseEvmEstimateTransactionRequest(missing)).toThrow(EvmWalletProtocolError);
  }
  for (const patch of [{ chainId: "42161" }, { accountId: "other" }, { to: OTHER_ADDRESS }, { valueWei: "8" }, { data: "0xaabc" }]) {
    expect(() => parseEvmEstimateTransactionResult({ ...estimateResult(), ...patch }, estimateRequest())).toThrow(EvmWalletProtocolError);
  }
});

test("Ethereum estimates distinguish base-plus-tip prices, raw gas price fallback, and maximum fee without adding value", () => {
  const dynamic = parseEvmEstimateTransactionResult(estimateResult(), estimateRequest());
  expect(dynamic.estimatedFeeWei).toBe("483000");
  expect(dynamic.maximumFeeWei).toBe("1050000");
  expect(dynamic.gasPriceWei).toBe("40");
  expect(BigInt(dynamic.estimatedFeeWei!)).not.toBe(21000n * 40n);
  expect(BigInt(dynamic.estimatedFeeWei!)).not.toBe(21000n * (20n + 3n) + 7n);
  const fallback = estimateResult({ feeBasis: "gas_price", baseFeePerGasWei: null, maxPriorityFeePerGasWei: null, maxFeePerGasWei: null, maximumFeeWei: null, estimatedFeeWei: "840000", blockNumber: null, reasons: ["Base fee observation unavailable; using gas price."] });
  expect(parseEvmEstimateTransactionResult(fallback, estimateRequest())).toEqual(fallback);
  const zero = estimateResult({ gasPriceWei: "0", baseFeePerGasWei: "0", maxPriorityFeePerGasWei: "0", maxFeePerGasWei: "0", estimatedFeeWei: "0", maximumFeeWei: "0" });
  expect(parseEvmEstimateTransactionResult(zero).estimatedFeeWei).toBe("0");
});

test("Arbitrum total-gas estimates include posting once and prefer raw gas price over base fee", () => {
  const arbitrum = estimateResult({ chainId: "42161", feeBasis: "arbitrum_total_gas", postingCosts: "included", estimatedFeeWei: "840000" });
  expect(parseEvmEstimateTransactionResult(arbitrum, estimateRequest({ chainId: "42161" }))).toEqual(arbitrum);
  const baseFallback = { ...arbitrum, gasPriceWei: null, estimatedFeeWei: "420000" };
  expect(parseEvmEstimateTransactionResult(baseFallback).estimatedFeeWei).toBe("420000");
  for (const patch of [
    { estimatedFeeWei: "483000" }, { estimatedFeeWei: "1680000" },
    { gasPriceWei: null, baseFeePerGasWei: null }, { postingCosts: "not_applicable" }, { postingCosts: "unavailable" },
  ]) expect(() => parseEvmEstimateTransactionResult({ ...arbitrum, ...patch })).toThrow(EvmWalletProtocolError);
});

test("unavailable estimates retain partial observations and reasons without pretending a total exists", () => {
  const unavailable = estimateResult({ status: "unavailable", feeBasis: "unavailable", postingCosts: "unavailable", gasLimit: null, gasPriceWei: null, baseFeePerGasWei: null, maxPriorityFeePerGasWei: null, maxFeePerGasWei: null, estimatedFeeWei: null, maximumFeeWei: null, blockNumber: null, reasons: ["RPC providers disagreed on the pending gas estimate."] });
  expect(parseEvmEstimateTransactionResult(unavailable, estimateRequest())).toEqual(unavailable);
  const partial = { ...unavailable, gasPriceWei: "40", baseFeePerGasWei: "20", maxPriorityFeePerGasWei: "3", blockNumber: "100" };
  expect(parseEvmEstimateTransactionResult(partial)).toEqual(partial);
  const postingOnly = { ...unavailable, chainId: "42161", gasLimit: "150000", postingCosts: "included" as const, reasons: ["Posting is included in the gas estimate; current price observations failed."] };
  expect(parseEvmEstimateTransactionResult(postingOnly)).toEqual(postingOnly);
  for (const patch of [{ reasons: [] }, { reasons: [""] }, { reasons: [null] }, { estimatedFeeWei: "0" }, { feeBasis: "gas_price" }]) {
    expect(() => parseEvmEstimateTransactionResult({ ...unavailable, ...patch })).toThrow(EvmWalletProtocolError);
  }
});

test("estimate amounts keep arbitrary-precision products and reject missing or inconsistent arithmetic evidence", () => {
  const huge = estimateResult({
    gasLimit: MAX_UINT256, gasPriceWei: MAX_UINT256, baseFeePerGasWei: MAX_UINT256, maxPriorityFeePerGasWei: "3", maxFeePerGasWei: MAX_UINT256,
    estimatedFeeWei: (BigInt(MAX_UINT256) * (BigInt(MAX_UINT256) + 3n)).toString(), maximumFeeWei: (BigInt(MAX_UINT256) ** 2n).toString(),
  });
  expect(parseEvmEstimateTransactionResult(huge)).toEqual(huge);
  expect(BigInt(huge.estimatedFeeWei!)).toBeGreaterThan(BigInt(MAX_UINT256));
  for (const patch of [
    { gasLimit: null }, { gasLimit: "0" }, { gasLimit: OVER_UINT256 }, { gasPriceWei: OVER_UINT256 },
    { baseFeePerGasWei: null }, { maxPriorityFeePerGasWei: null }, { maxFeePerGasWei: OVER_UINT256 },
    { estimatedFeeWei: null }, { estimatedFeeWei: "483001" }, { estimatedFeeWei: "4.83e5" },
    { maximumFeeWei: "1050001" }, { maxFeePerGasWei: null }, { feeBasis: "unavailable" }, { status: "unavailable" },
  ]) expect(() => parseEvmEstimateTransactionResult({ ...estimateResult(), ...patch })).toThrow(EvmWalletProtocolError);
  expect(() => parseEvmEstimateTransactionResult(estimateResult({ feeBasis: "gas_price", gasPriceWei: null }))).toThrow(EvmWalletProtocolError);
  const unsafeProduct = Number(huge.estimatedFeeWei);
  expect(() => parseEvmEstimateTransactionResult({ ...huge, estimatedFeeWei: unsafeProduct })).toThrow(EvmWalletProtocolError);
});

test("estimate calls snapshot the exact invocation and stay on their read tool even when transport fails", async () => {
  const reply = deferred<EvmEstimateTransactionResult>();
  const mock = transport(() => reply.promise);
  const request = estimateRequest();
  const original = structuredClone(request);
  const controller = new AbortController();
  const options = { timeout: 100, signal: controller.signal, control: "root", transportContext: { invocationId: "spoofed" } };
  const pending = mock.client.estimateTransaction(request, options);
  request.to = OTHER_ADDRESS; request.chainId = "42161"; request.valueWei = "8";
  reply.resolve(estimateResult());
  expect(await pending).toEqual(estimateResult());
  expect(mock.calls).toEqual([{ call: { target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.estimateTransaction, arguments: original }, options: { timeout: 100, signal: controller.signal } }]);
  const unavailable = transport(() => { throw new Error("Estimate transport unavailable"); });
  await expect(unavailable.client.estimateTransaction(original)).rejects.toThrow("Estimate transport unavailable");
  expect(unavailable.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.estimateTransaction]);
});

test("new evidence tools do not loosen previously released closed schemas", () => {
  for (const patch of [{ tokenEvidence: [] }, { walletReplacementMatches: false }]) {
    expect(() => parseEvmBalancesResult({ ...balanceResult(), ...patch })).toThrow(EvmWalletProtocolError);
    expect(() => parseEvmReadContractResult({ ...readResult(), ...patch })).toThrow(EvmWalletProtocolError);
    expect(() => parseEvmTransactionResult({ ...chainEvidence(), ...patch })).toThrow(EvmWalletProtocolError);
    expect(() => parseEvmOperationResult({ ...operation(), ...patch })).toThrow(EvmWalletProtocolError);
    expect(() => parseEvmSendTransactionRequest({ ...transaction(), ...patch })).toThrow(EvmWalletProtocolError);
  }
});

test("public transaction evidence cannot mix networks, hashes, pending transactions or receipts from different blocks", () => {
  const request = { chainId: "1", transactionHash: HASH };
  expect(parseEvmTransactionResult(chainEvidence(), request)).toEqual(chainEvidence());
  const included = chainEvidence().transaction!;
  for (const patch of [
    { chainId: "42161" }, { transactionHash: FINGERPRINT }, { source: "browser_cache" }, { provider: "secret" },
    { transaction: null }, { transaction: { ...included, nonce: OVER_UINT256 } },
    { transaction: { ...included, valueWei: OVER_UINT256 } }, { transaction: { ...included, blockNumber: null } },
    { transaction: { ...included, blockNumber: null, blockHash: null } },
    { receipt: receipt({ blockNumber: "101" }) }, { receipt: receipt({ blockHash: FINGERPRINT }) },
  ]) expect(() => parseEvmTransactionResult({ ...chainEvidence(), ...patch }, request)).toThrow(EvmWalletProtocolError);
  const pending = chainEvidence({ transaction: { ...included, blockNumber: null, blockHash: null }, receipt: null });
  expect(parseEvmTransactionResult(pending, request)).toEqual(pending);
  const absent = chainEvidence({ transaction: null, receipt: null });
  expect(parseEvmTransactionResult(absent, request)).toEqual(absent);
  for (const patch of [{ chainId: "0" }, { chainId: OVER_UINT256 }, { transactionHash: "0x00" }, { caller: "uniswap" }]) {
    expect(() => parseEvmTransactionRequest({ ...request, ...patch })).toThrow(EvmWalletProtocolError);
  }
});

test("transaction journal references use closed identities with canonical installation UIDs", () => {
  const reference = { callerAppId: "wallet", callerInstallationUid: "18446744073709551615", requestId: IDENTITY.requestId };
  const request = { chainId: "1", transactionHash: `0x${"AB".repeat(32)}`, walletRequest: reference };
  expect(parseEvmTransactionRequest(request)).toEqual({ ...request, transactionHash: `0x${"ab".repeat(32)}` });
  for (const callerInstallationUid of ["", "0", "01", "-1", "1.0", "1e3", "1\n", "1\r\n", "18446744073709551616", 1, null]) {
    expect(() => parseEvmTransactionRequest({ ...request, walletRequest: { ...reference, callerInstallationUid } })).toThrow(EvmWalletProtocolError);
  }
  for (const patch of [{ callerAppId: "" }, { requestId: "f".repeat(31) }, { requestId: "F".repeat(32) }, { requestId: `${IDENTITY.requestId}\n` }, { audience: "agent_root" }, { caller: { appId: "agent" } }, { walletRequestMatches: true }]) {
    expect(() => parseEvmTransactionRequest({ ...request, walletRequest: { ...reference, ...patch } })).toThrow(EvmWalletProtocolError);
  }
  for (const key of Object.keys(reference)) {
    const missing = { ...reference } as Record<string, unknown>; delete missing[key];
    expect(() => parseEvmTransactionRequest({ ...request, walletRequest: missing })).toThrow(EvmWalletProtocolError);
  }
  for (const walletRequest of [null, [], "wallet", Object.create(reference)]) expect(() => parseEvmTransactionRequest({ ...request, walletRequest })).toThrow(EvmWalletProtocolError);
  expect(() => parseEvmTransactionRequest({ ...request, walletRequestMatches: true })).toThrow(EvmWalletProtocolError);
});

test("journal binding results distinguish a checked mismatch from an unrequested lookup", () => {
  const unbound = { chainId: "1", transactionHash: HASH };
  const bound = { ...unbound, walletRequest: { callerAppId: "wallet", callerInstallationUid: "7", requestId: IDENTITY.requestId } };
  expect(parseEvmTransactionResult(chainEvidence(), unbound).walletRequestMatches).toBeNull();
  for (const walletRequestMatches of [true, false]) {
    expect(parseEvmTransactionResult(chainEvidence({ walletRequestMatches }), bound).walletRequestMatches).toBe(walletRequestMatches);
    expect(() => parseEvmTransactionResult(chainEvidence({ walletRequestMatches }), unbound)).toThrow("binding result");
  }
  expect(() => parseEvmTransactionResult(chainEvidence(), bound)).toThrow("binding result");
  const { walletRequestMatches: _removed, ...missing } = chainEvidence();
  expect(() => parseEvmTransactionResult(missing, unbound)).toThrow(EvmWalletProtocolError);
  for (const walletRequestMatches of ["true", "false", 1, 0, {}, []]) {
    expect(() => parseEvmTransactionResult({ ...chainEvidence(), walletRequestMatches }, bound)).toThrow(EvmWalletProtocolError);
  }
});

test("transaction lookup forwards a snapshotted journal reference without giving it caller authority", async () => {
  const reply = deferred<EvmTransactionResult>();
  const mock = transport(() => reply.promise);
  const reference = { callerAppId: "wallet", callerInstallationUid: "7", requestId: IDENTITY.requestId };
  const request = { chainId: "1", transactionHash: HASH, walletRequest: reference };
  const original = structuredClone(request);
  const options = { timeout: 100, transportContext: { invocationId: "spoofed" }, control: "root", caller: { appId: "agent", installationUid: "1" } };
  const pending = mock.client.transaction(request, options);
  reference.callerAppId = "agent";
  reference.callerInstallationUid = "8";
  reference.requestId = "f".repeat(32);
  reply.resolve(chainEvidence({ walletRequestMatches: false }));
  const result = await pending;
  expect(result.walletRequestMatches).toBe(false);
  expect(mock.calls).toEqual([{ call: { target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.transaction, arguments: original }, options: { timeout: 100 } }]);
  expect(result).not.toHaveProperty("walletRequest");
});

test("replacement journal proof requests are closed, normalized references rather than authority or replacement effects", () => {
  const request = replacementProofRequest({ transactionHash: `0x${"AB".repeat(32)}` });
  expect(parseEvmReplacementTransactionRequest(request)).toEqual({ ...request, transactionHash: `0x${"ab".repeat(32)}` });
  for (const patch of [
    { chainId: "0" }, { chainId: "01" }, { chainId: OVER_UINT256 }, { transactionHash: "0x00" },
    { walletReplacementMatches: true }, { walletRequest: request.originalWalletRequest }, { audience: "agent_root" }, { cancel: true },
  ]) expect(() => parseEvmReplacementTransactionRequest({ ...request, ...patch })).toThrow(EvmWalletProtocolError);
  for (const originalWalletRequest of [
    null, {}, [], { ...request.originalWalletRequest, callerAppId: "" },
    { ...request.originalWalletRequest, callerInstallationUid: "0" },
    { ...request.originalWalletRequest, callerInstallationUid: "7\n" },
    { ...request.originalWalletRequest, callerInstallationUid: "18446744073709551616" },
    { ...request.originalWalletRequest, requestId: "F".repeat(32) },
    { ...request.originalWalletRequest, caller: { appId: "agent", installationUid: "1" } },
  ]) expect(() => parseEvmReplacementTransactionRequest({ ...request, originalWalletRequest })).toThrow(EvmWalletProtocolError);
  for (const key of Object.keys(request)) {
    const missing = { ...request } as Record<string, unknown>; delete missing[key];
    expect(() => parseEvmReplacementTransactionRequest(missing)).toThrow(EvmWalletProtocolError);
  }
});

test("replacement proofs bind every echoed command field and distinguish mismatch from inclusion or execution success", () => {
  const request = replacementProofRequest();
  for (const walletReplacementMatches of [true, false]) {
    expect(parseEvmReplacementTransactionResult(replacementProof({ walletReplacementMatches }), request).walletReplacementMatches).toBe(walletReplacementMatches);
  }
  for (const patch of [
    { chainId: "42161" }, { transactionHash: FINGERPRINT },
    { originalWalletRequest: { ...request.originalWalletRequest, callerAppId: "wallet" } },
    { originalWalletRequest: { ...request.originalWalletRequest, callerInstallationUid: "8" } },
    { originalWalletRequest: { ...request.originalWalletRequest, requestId: "f".repeat(32) } },
    { walletReplacementMatches: null }, { walletReplacementMatches: "false" }, { walletReplacementMatches: 1 },
    { observedAtNs: "01" }, { source: "evm_rpc" }, { receipt: receipt() }, { status: "confirmed" },
  ]) expect(() => parseEvmReplacementTransactionResult({ ...replacementProof(), ...patch }, request)).toThrow(EvmWalletProtocolError);
  for (const key of Object.keys(replacementProof())) {
    const missing = { ...replacementProof() } as Record<string, unknown>; delete missing[key];
    expect(() => parseEvmReplacementTransactionResult(missing, request)).toThrow(EvmWalletProtocolError);
  }
});

test("replacement journal proof lookup preserves its original reference and never forwards authority or invokes an effect", async () => {
  const reply = deferred<EvmReplacementTransactionResult>();
  const mock = transport(() => reply.promise);
  const request = replacementProofRequest();
  const original = structuredClone(request);
  const options = { timeout: 100, transportContext: { invocationId: "spoofed" }, control: "root", caller: { appId: "agent" } };
  const pending = mock.client.replacementTransaction(request, options);
  request.originalWalletRequest.callerAppId = "agent";
  request.originalWalletRequest.callerInstallationUid = "8";
  request.originalWalletRequest.requestId = "f".repeat(32);
  reply.resolve(replacementProof({ walletReplacementMatches: false }));
  expect((await pending).walletReplacementMatches).toBe(false);
  expect(mock.calls).toEqual([{ call: { target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.replacementTransaction, arguments: original }, options: { timeout: 100 } }]);
  const mismatched = transport(() => replacementProof({ chainId: "42161" }));
  await expect(mismatched.client.replacementTransaction(original)).rejects.toThrow("does not match");
  expect(mismatched.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.replacementTransaction]);
});

test("operation results require consistent transaction evidence and cannot cross request identity", () => {
  expect(parseEvmOperationResult(operation(), IDENTITY, "transaction")).toEqual(operation());
  expect(parseEvmOperationStatusResult({ ...IDENTITY, status: "not_found" }, IDENTITY)).toEqual({ ...IDENTITY, status: "not_found" });
  for (const patch of [{ chainId: "42161" }, { requestId: "f".repeat(32) }, { caller: "agent" }, { status: "finished" }, { transactionHash: null }, { status: "confirmed" }, { status: "reverted", receipt: receipt() }]) {
    expect(() => parseEvmOperationResult({ ...operation(), ...patch }, IDENTITY, "transaction")).toThrow(EvmWalletProtocolError);
  }
  expect(() => parseEvmOperationStatusResult({ ...IDENTITY, status: "not_found", chainId: "42161" }, IDENTITY)).toThrow();
  expect(() => parseEvmOperationStatusResult({ ...IDENTITY, status: "not_found", operationId: "1" }, IDENTITY)).toThrow();
  expect(parseEvmOperationResult(operation({ status: "confirmed", receipt: receipt() })).receipt!.finality).toBe("included");
  expect(parseEvmOperationResult(operation({ status: "reverted", receipt: receipt({ status: "reverted" }) })).status).toBe("reverted");
  expect(() => parseEvmReceipt(receipt({ logs: [...receipt().logs, ...receipt().logs] }))).toThrow("duplicate receipt log");
  expect(() => parseEvmReceipt({ ...receipt(), logs: [{ ...receipt().logs[0], provider: "secret" }] })).toThrow();
});

test("replaced operations require distinct replacement evidence and cannot claim the original transaction succeeded", () => {
  const replaced = operation({ status: "replaced", replacementTransactionHash: FINGERPRINT });
  expect(parseEvmOperationResult(replaced, IDENTITY, "transaction")).toEqual(replaced);
  expect(parseEvmOperationStatusResult(replaced, IDENTITY)).toEqual(replaced);
  expect(evmOperationIsTerminal(replaced)).toBe(true);
  expect(replaced.receipt).toBeNull();
  for (const patch of [
    { transactionHash: null }, { replacementTransactionHash: null }, { replacementTransactionHash: "0x00" },
    { replacementTransactionHash: HASH }, { receipt: receipt() }, { receipt: receipt({ status: "reverted" }) },
  ]) expect(() => parseEvmOperationResult({ ...replaced, ...patch }, IDENTITY, "transaction")).toThrow(EvmWalletProtocolError);
  expect(() => parseEvmOperationResult(operation({ status: "replaced" }))).toThrow(EvmWalletProtocolError);
  expect(() => parseEvmOperationResult(operation({ status: "replaced", transactionHash: `0x${"ab".repeat(32)}`, replacementTransactionHash: `0x${"AB".repeat(32)}` }))).toThrow("replace itself");
  for (const kind of ["message", "typed_data"] as const) {
    const signed = operation({ kind, status: "signed", transactionHash: null, signature: SIGNATURE });
    expect(() => parseEvmOperationResult({ ...signed, replacementTransactionHash: FINGERPRINT })).toThrow("transaction evidence");
    expect(() => parseEvmOperationResult({ ...signed, status: "replaced" })).toThrow("transaction state");
  }
});

test("pending or mined replacements reconcile without resubmitting the original intent", async () => {
  const saved: EvmWalletIntent = { version: 1, kind: "transaction", request: transaction(), walletAddress: ADDRESS, walletKeyFingerprint: FINGERPRINT };
  for (const status of ["unknown", "replaced"] as const) {
    const result = operation({ status, replacementTransactionHash: FINGERPRINT });
    const mock = transport((call) => call.name === EVM_WALLET_TOOLS.accounts ? { accounts: [ACCOUNT] } : result);
    const reconciled = await resumeEvmWalletIntent(mock.client, saved);
    expect(reconciled).toEqual(result);
    expect(reconciled.receipt).toBeNull();
    expect(evmOperationIsTerminal(reconciled)).toBe(status === "replaced");
    expect(mock.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.operationStatus]);
  }
});

test("message and typed-data results cannot claim success without a signature or borrow transaction status", () => {
  for (const kind of ["message", "typed_data"] as const) {
    const valid = operation({ kind, status: "signed", transactionHash: null, signature: SIGNATURE });
    expect(parseEvmOperationResult(valid, IDENTITY, kind)).toEqual(valid);
    for (const patch of [{ signature: null }, { signature: "0x00" }, { transactionHash: HASH }, { receipt: receipt() }, { status: "submitted" }, { status: "reverted" }]) {
      expect(() => parseEvmOperationResult({ ...valid, ...patch }, IDENTITY, kind)).toThrow(EvmWalletProtocolError);
    }
    expect(() => parseEvmOperationResult(valid, IDENTITY, "transaction")).toThrow("kind");
  }
  expect(evmOperationIsTerminal({ ...IDENTITY, status: "not_found" })).toBe(false);
  for (const status of ["preparing", "prepared", "signing", "signed", "submitted", "unknown"] as const) expect(evmOperationIsTerminal(operation({ status }))).toBe(false);
  for (const status of ["confirmed", "reverted", "rejected", "failed"] as const) expect(evmOperationIsTerminal(operation({ status }))).toBe(true);
  expect(evmOperationIsTerminal(operation({ kind: "message", status: "signed", transactionHash: null, signature: SIGNATURE }))).toBe(true);
});

test("wallet caller identity requires a Kernel installation UID and root effects require audience attestation", () => {
  const caller = { endpoint: "app:uniswap:background", appId: "uniswap", installationUid: "18446744073709551615" };
  expect(requireEvmWalletCaller({ caller })).toEqual({ appId: "uniswap", installationUid: "18446744073709551615" });
  expect(requireEvmWalletCaller({ caller, audience: "agent_root" }, true)).toEqual({ appId: "uniswap", installationUid: "18446744073709551615" });
  for (const installationUid of [undefined, "", "0", "01", "-1", "1.0", "1e3", "1\n", "1\r\n", "18446744073709551616", 1]) {
    expect(() => requireEvmWalletCaller({ caller: { ...caller, installationUid } } as Pick<MsgBusToolContext, "caller" | "audience">)).toThrow("installation identity");
  }
  expect(() => requireEvmWalletCaller({})).toThrow("installation identity");
  expect(() => requireEvmWalletCaller({ caller: { endpoint: caller.endpoint, installationUid: "1" } })).toThrow("installation identity");
  expect(() => requireEvmWalletCaller({ caller: { ...caller, role: "agent", agentMode: true } }, true)).toThrow("root-agent attestation");
  expect(() => requireEvmWalletCaller({ caller, audience: "foreground_tile" }, true)).toThrow("root-agent attestation");
});

test("public and root SDK methods choose distinct tools while leaving authority to the injected transport", async () => {
  const mock = transport((call) => {
    const kind: EvmEffectKind = call.name.includes("typed_data") ? "typed_data" : call.name.includes("message") ? "message" : "transaction";
    return operation({ kind, ...(kind === "transaction" ? {} : { status: "signed", signature: SIGNATURE, transactionHash: null }) });
  });
  const message = { ...IDENTITY, messageHex: "0xaabb" };
  const typed = { ...IDENTITY, typedDataJson: TYPED_DATA_JSON };
  await mock.client.sendTransaction(transaction());
  await mock.client.sendTransactionRoot(transaction());
  await mock.client.signMessage(message);
  await mock.client.signMessageRoot(message);
  await mock.client.signTypedData(typed);
  await mock.client.signTypedDataRoot(typed);
  expect(mock.calls.map(({ call }) => call.name)).toEqual([
    EVM_WALLET_TOOLS.sendTransaction, EVM_WALLET_TOOLS.sendTransactionRoot,
    EVM_WALLET_TOOLS.signMessage, EVM_WALLET_TOOLS.signMessageRoot,
    EVM_WALLET_TOOLS.signTypedData, EVM_WALLET_TOOLS.signTypedDataRoot,
  ]);
  for (const { call, options } of mock.calls) {
    expect(call.target).toBe(EVM_WALLET_TARGET);
    expect(Object.keys(call).sort()).toEqual(["arguments", "name", "target"]);
    expect(call.arguments).not.toHaveProperty("caller");
    expect(call.arguments).not.toHaveProperty("audience");
    expect(options).toEqual({});
  }
  expect(mock.calls[4]!.call.arguments!.typedDataJson).toBe(TYPED_DATA_JSON);
  const denied = transport(() => { throw new Error("INVOCATION_INVALID"); });
  await expect(denied.client.sendTransactionRoot(transaction())).rejects.toThrow("INVOCATION_INVALID");
  expect(denied.calls).toHaveLength(1);
});

test("SDK forwards cancellation and progress options without retrying malformed inputs or mismatched responses", async () => {
  const mock = transport(() => operation({ chainId: "42161" }));
  const controller = new AbortController();
  const onProgress = (_value: JsonValue) => {};
  const client = createEvmWalletClient(mock.kernel, { callOptions: { timeout: 100, onProgress } });
  await expect(client.sendTransaction(transaction(), { timeout: 200, signal: controller.signal })).rejects.toThrow("network");
  expect(mock.calls[0]!.options).toEqual({ timeout: 200, onProgress, signal: controller.signal });
  await expect(client.sendTransaction({ ...transaction(), caller: "agent" } as EvmSendTransactionRequest)).rejects.toThrow(EvmWalletProtocolError);
  expect(mock.calls).toHaveLength(1);
});

test("consumer call options cannot replace the injected invocation authority", async () => {
  const mock = transport(() => operation());
  const options = { timeout: 200, control: "root", transportContext: { invocationId: "spoofed" }, caller: { appId: "agent", installationUid: "1" } };
  const client = createEvmWalletClient(mock.kernel, { callOptions: options });
  await client.sendTransactionRoot(transaction(), options);
  expect(mock.calls[0]!.options).toEqual({ timeout: 200 });
});

test("speed-up and cancellation use distinct public and root replacement tools without inventing authority", async () => {
  const mock = transport(() => operation({ operationId: "13" }));
  const speedUp = replacement();
  const cancel = replacement({ cancel: true });
  const spoofedOptions = { timeout: 100, transportContext: { invocationId: "spoofed" }, control: "root" };
  expect((await mock.client.replaceTransaction(speedUp, spoofedOptions)).operationId).toBe("13");
  expect((await mock.client.replaceTransactionRoot(cancel, spoofedOptions)).operationId).toBe("13");
  expect(mock.calls).toEqual([
    { call: { target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.replaceTransaction, arguments: speedUp }, options: { timeout: 100 } },
    { call: { target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.replaceTransactionRoot, arguments: cancel }, options: { timeout: 100 } },
  ]);
  const denied = transport(() => { throw new Error("INVOCATION_INVALID"); });
  await expect(denied.client.replaceTransactionRoot(cancel)).rejects.toThrow("INVOCATION_INVALID");
  expect(denied.calls).toHaveLength(1);
});

test("replacement responses bind the new request identity and transaction kind without retrying effects", async () => {
  for (const result of [
    operation({ chainId: "42161" }), operation({ requestId: "f".repeat(32) }),
    operation({ kind: "message", status: "signed", transactionHash: null, signature: SIGNATURE }),
  ]) {
    const mock = transport(() => result);
    await expect(mock.client.replaceTransaction(replacement())).rejects.toThrow(EvmWalletProtocolError);
    await expect(mock.client.replaceTransactionRoot(replacement({ cancel: true }))).rejects.toThrow(EvmWalletProtocolError);
    expect(mock.calls).toHaveLength(2);
  }
  const invalid = transport(() => operation());
  await expect(invalid.client.replaceTransaction({ ...replacement(), cancel: "false" } as unknown as EvmReplaceTransactionRequest)).rejects.toThrow(EvmWalletProtocolError);
  expect(invalid.calls).toHaveLength(0);
});

test("discovery and scoped read methods use their public tools with checked arguments", async () => {
  const mock = transport((call) => {
    if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [ACCOUNT] };
    if (call.name === EVM_WALLET_TOOLS.networks) return { networks: [] };
    if (call.name === EVM_WALLET_TOOLS.balances) return balanceResult();
    if (call.name === EVM_WALLET_TOOLS.readContract) return readResult();
    if (call.name === EVM_WALLET_TOOLS.transaction) return chainEvidence();
    if (call.name === EVM_WALLET_TOOLS.operationStatus) return { ...IDENTITY, status: "not_found" };
    throw new Error("Unexpected effect");
  });
  expect((await mock.client.accounts()).accounts[0]).toEqual(ACCOUNT);
  expect(await mock.client.networks()).toEqual({ networks: [] });
  expect(await mock.client.balances({ ...SCOPE, tokens: [TOKEN] })).toEqual(balanceResult());
  expect(await mock.client.readContract({ ...SCOPE, to: TOKEN, data: "0xaabb" })).toEqual(readResult());
  expect(await mock.client.transaction({ chainId: "1", transactionHash: HASH })).toEqual(chainEvidence());
  expect(await mock.client.operationStatus(IDENTITY)).toEqual({ ...IDENTITY, status: "not_found" });
  expect(mock.calls.map(({ call }) => call.arguments)).toEqual([{}, {}, { ...SCOPE, tokens: [TOKEN] }, { ...SCOPE, to: TOKEN, data: "0xaabb" }, { chainId: "1", transactionHash: HASH }, IDENTITY]);
});

test("intent preparation snapshots input before discovery and waits for durable storage before returning", async () => {
  const discovery = deferred<unknown>();
  const persistence = deferred<void>();
  const persistenceStarted = deferred<void>();
  const mock = transport(() => discovery.promise);
  const request = transaction({ accessList: [{ address: TOKEN, storageKeys: [HASH] }] });
  let persisted: EvmWalletIntent | undefined;
  let completed = false;
  const pending = prepareEvmWalletIntent(mock.client, "transaction", request, async (intent) => {
    persisted = structuredClone(intent);
    intent.request.chainId = "42161";
    persistenceStarted.resolve();
    await persistence.promise;
  }).then((intent) => { completed = true; return intent; });
  request.to = OTHER_ADDRESS;
  request.accessList![0]!.storageKeys.push(FINGERPRINT);
  discovery.resolve({ accounts: [ACCOUNT] });
  await persistenceStarted.promise;
  expect(completed).toBe(false);
  expect(persisted!.request).toEqual(transaction({ accessList: [{ address: TOKEN, storageKeys: [HASH] }] }));
  expect(mock.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  persistence.resolve();
  expect(await pending).toEqual(persisted!);
});

test("failed durable storage cannot progress to a wallet effect", async () => {
  const mock = transport(() => ({ accounts: [ACCOUNT] }));
  await expect(prepareEvmWalletIntent(mock.client, "transaction", transaction(), async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect(mock.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  for (const patch of [{ version: 2 }, { walletAddress: "0x00" }, { walletKeyFingerprint: "0x00" }, { kind: "raw_digest" }, { caller: "agent" }]) {
    expect(() => parseEvmWalletIntent({ version: 1, kind: "transaction", request: transaction(), walletAddress: ADDRESS, walletKeyFingerprint: FINGERPRINT, ...patch })).toThrow(EvmWalletProtocolError);
  }
});

test("lost submission reply is reconciled from the saved identity without allocating or resending an effect", async () => {
  let saved: EvmWalletIntent | undefined;
  let accepted: EvmOperationResult | undefined;
  let effectCalls = 0;
  const mock = transport((call) => {
    if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [ACCOUNT] };
    if (call.name === EVM_WALLET_TOOLS.operationStatus) return accepted ?? { ...IDENTITY, status: "not_found" };
    if (call.name === EVM_WALLET_TOOLS.sendTransaction) {
      expect(saved).toBeDefined();
      expect(call.arguments).toEqual(saved!.request);
      accepted = operation(); effectCalls++;
      throw new Error("reply lost after wallet accepted operation");
    }
    throw new Error("Unexpected tool");
  });
  const prepared = await prepareEvmWalletIntent(mock.client, "transaction", transaction(), async (intent) => { saved = JSON.parse(JSON.stringify(intent)) as EvmWalletIntent; });
  await expect(resumeEvmWalletIntent(mock.client, prepared)).rejects.toThrow("reply lost");
  const reloaded = parseEvmWalletIntent(JSON.parse(JSON.stringify(saved)));
  expect(await resumeEvmWalletIntent(mock.client, reloaded)).toEqual(operation());
  expect(effectCalls).toBe(1);
  expect(mock.calls.filter(({ call }) => call.name === EVM_WALLET_TOOLS.operationStatus).map(({ call }) => call.arguments)).toEqual([IDENTITY, IDENTITY]);
});

test("uncertain operation status is not permission to submit again", async () => {
  const saved: EvmWalletIntent = { version: 1, kind: "transaction", request: transaction(), walletAddress: ADDRESS, walletKeyFingerprint: FINGERPRINT };
  const mock = transport((call) => {
    if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [ACCOUNT] };
    throw new Error("RPC or transport unavailable");
  });
  await expect(resumeEvmWalletIntent(mock.client, saved)).rejects.toThrow("unavailable");
  expect(mock.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.operationStatus]);
  const unknown = transport((call) => call.name === EVM_WALLET_TOOLS.accounts ? { accounts: [ACCOUNT] } : operation({ status: "unknown" }));
  expect((await resumeEvmWalletIntent(unknown.client, saved)).status).toBe("unknown");
  expect(unknown.calls).toHaveLength(2);
});

test("wallet replacement blocks replay before status lookup or signing even when only the fingerprint changed", async () => {
  const saved: EvmWalletIntent = { version: 1, kind: "transaction", request: transaction(), walletAddress: ADDRESS, walletKeyFingerprint: FINGERPRINT };
  for (const accounts of [[], [{ ...ACCOUNT, address: OTHER_ADDRESS }], [{ ...ACCOUNT, keyFingerprint: HASH }]]) {
    const mock = transport(() => ({ accounts }));
    await expect(resumeEvmWalletIntent(mock.client, saved)).rejects.toThrow("identity changed");
    expect(mock.calls.map(({ call }) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  }
});

test("saved intents reject known-operation address and kind substitution without fresh effects", async () => {
  const saved: EvmWalletIntent = { version: 1, kind: "transaction", request: transaction(), walletAddress: ADDRESS, walletKeyFingerprint: FINGERPRINT };
  for (const result of [operation({ address: OTHER_ADDRESS }), operation({ kind: "message", status: "signed", signature: SIGNATURE, transactionHash: null })]) {
    const mock = transport((call) => call.name === EVM_WALLET_TOOLS.accounts ? { accounts: [ACCOUNT] } : result);
    await expect(resumeEvmWalletIntent(mock.client, saved)).rejects.toThrow("account or kind changed");
    expect(mock.calls).toHaveLength(2);
  }
});

test("a definitive not-found resumes the same stored message or typed-data request through human tools", async () => {
  for (const kind of ["message", "typed_data"] as const) {
    const request = kind === "message" ? { ...IDENTITY, messageHex: "0x00ff" } : { ...IDENTITY, typedDataJson: TYPED_DATA_JSON };
    const saved: EvmWalletIntent = { version: 1, kind, request, walletAddress: ADDRESS, walletKeyFingerprint: FINGERPRINT };
    const mock = transport((call) => {
      if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [ACCOUNT] };
      if (call.name === EVM_WALLET_TOOLS.operationStatus) return { ...IDENTITY, status: "not_found" };
      return operation({ kind, status: "signed", signature: SIGNATURE, transactionHash: null });
    });
    expect((await resumeEvmWalletIntent(mock.client, saved)).signature).toBe(SIGNATURE);
    expect(mock.calls[2]!.call).toEqual({ target: EVM_WALLET_TARGET, name: kind === "message" ? EVM_WALLET_TOOLS.signMessage : EVM_WALLET_TOOLS.signTypedData, arguments: request });
  }
});

test("concurrent Ethereum and Arbitrum intents retain independent scopes with out-of-order replies", async () => {
  const identities = [IDENTITY, { ...IDENTITY, chainId: "42161" }];
  const replies = new Map(identities.map((identity) => [identity.chainId, deferred<EvmOperationResult>()]));
  const allStarted = deferred<void>();
  const persisted = new Map<string, EvmWalletIntent>();
  const started: EvmEffectIdentity[] = [];
  const mock = transport((call) => {
    if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [ACCOUNT] };
    const args = call.arguments!;
    if (call.name === EVM_WALLET_TOOLS.operationStatus) return { ...args, status: "not_found" };
    if (call.name === EVM_WALLET_TOOLS.sendTransaction) {
      const chainId = args.chainId as string;
      expect(args).toEqual(persisted.get(chainId)!.request);
      started.push({ accountId: args.accountId as "main", chainId, requestId: args.requestId as string });
      if (started.length === 2) allStarted.resolve();
      return replies.get(chainId)!.promise;
    }
    throw new Error("Unexpected tool");
  });
  const intents = await Promise.all(identities.map((identity) => prepareEvmWalletIntent(mock.client, "transaction", transaction(identity), async (intent) => { persisted.set(intent.request.chainId, intent); })));
  const ethereum = resumeEvmWalletIntent(mock.client, intents[0]!);
  const arbitrum = resumeEvmWalletIntent(mock.client, intents[1]!);
  await allStarted.promise;
  expect(started).toEqual(identities);
  replies.get("42161")!.resolve(operation({ chainId: "42161", operationId: "2" }));
  expect((await arbitrum).chainId).toBe("42161");
  replies.get("1")!.resolve(operation());
  expect((await ethereum).chainId).toBe("1");
  expect(mock.calls.filter(({ call }) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toHaveLength(2);
});

test("request ID generation retains all 128 random bits and effect dispatch rejects an unknown kind", () => {
  const id = createEvmRequestId((bytes) => { for (let index = 0; index < bytes.length; index++) bytes[index] = index * 17; });
  expect(id).toBe("00112233445566778899aabbccddeeff");
  expect(() => parseEvmEffectRequest("raw_digest" as EvmEffectKind, transaction())).toThrow("effect kind");
});
