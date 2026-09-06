import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validate, type Schema } from "jsonschema";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { encodeSelfCallValues, type SelfCallValue } from "neutron-tools/app";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import {
  parseEvmOperationResult, parseEvmReplacementTransactionResult, parseEvmTransactionResult,
  type EvmAccount, type EvmOperationResult, type EvmOperationStatusRequest, type EvmOperationStatusResult,
  type EvmReceipt, type EvmReceiptLog, type EvmSendTransactionRequest,
  type EvmReplacementTransactionRequest, type EvmReplacementTransactionResult, type EvmTransactionRequest, type EvmTransactionResult, type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import {
  approvalConfirmed, createSwapStore, effectiveOperation, executeStep, parseSwapRecord, receivedTokenAtoms, reconcileStep,
  savedIntent, storedOperation, validateOperation, verifyAgentResult, walletReader, walletRequest,
  type SavedIntent, type Store, type SwapRecord,
} from "../src/controller.ts";
import { swapTransaction, type Quote, type Transaction } from "../src/swap.ts";

const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const OTHER = getAddress("0x3333333333333333333333333333333333333333");
const ROUTER = getAddress("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45");
const QUOTER = getAddress("0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const WETH = getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
const APPROVAL_ID = "11".repeat(16), SWAP_ID = "22".repeat(16), OTHER_ID = "33".repeat(16);
const HASH = `0x${"44".repeat(32)}`;
const REPLACEMENT_HASH = `0x${"99".repeat(32)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;
const account: EvmAccount = {
  accountId: "main", address: ACCOUNT,
  publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1",
};
const tokenAbi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const methodSchemas = generateAppMethodSchemaArtifact(
  JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest,
  readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"),
);

function checkMethodInput(method: string, args: unknown[]) {
  encodeSelfCallValues(args as SelfCallValue[]);
  expect(validateAppMethodArgs(methodSchemas, method, args as Parameters<typeof validateAppMethodArgs>[2])).toEqual({ valid: true, errors: [] });
}
function checkMethodOutput<T>(method: string, value: T): T {
  const result = validate(value, methodSchemas.methods[method]!.output as Schema);
  expect(result.errors.map((error) => error.stack)).toEqual([]);
  return value;
}
// Kernel's Candid projection omits empty option fields inside records and
// unwraps successful Result values; a top-level empty option is JSON null.
function wireRecord(value: SwapRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
}

function intent(options: { approval?: boolean; mode?: "human" | "agent"; expired?: boolean } = {}): SavedIntent {
  const quote: Quote = {
    chainId: "1", accountId: "main", accountAddress: ACCOUNT,
    tokenIn: { chainId: "1", address: options.approval ? USDC : null, decimals: options.approval ? 6 : 18, symbol: options.approval ? "USDC" : "ETH" },
    tokenOut: { chainId: "1", address: options.approval ? WETH : USDC, decimals: options.approval ? 18 : 6, symbol: options.approval ? "WETH" : "USDC" },
    amountIn: "1000000", slippageBps: 50, recipient: RECIPIENT,
    deadline: String(Math.floor(Date.now() / 1000) + (options.expired ? -60 : 3600)),
    router: ROUTER, quoter: QUOTER, fee: 500, amountOut: "2000000", minimumOut: "1990000",
    gasEstimate: "90000", priceImpactBps: "10", quotedAtMs: Date.now(), blockNumber: "21000000", pool: OTHER, routeWarnings: [],
  };
  const approval: Transaction | null = options.approval ? {
    chainId: "1", accountId: "main", to: USDC, value: "0",
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [ROUTER, 1_000_000n] }),
  } : null;
  return { quote, approval, swap: swapTransaction(quote, 0), allowance: options.approval ? "0" : null, account: { ...account }, executionMode: options.mode ?? "human", walletCaller: options.mode === "agent" ? { appId: "agent", installationUid: "17" } : null };
}

function record(saved = intent()): SwapRecord {
  const approval = saved.approval ? walletRequest(saved.approval, APPROVAL_ID) : null;
  const swap = walletRequest(saved.swap, SWAP_ID);
  return {
    id: "swap-journal-1", account_id: saved.quote.accountId, chain_id: saved.quote.chainId,
    recipient: saved.quote.recipient, quote_json: JSON.stringify(saved),
    approval_request_id: approval?.requestId ?? null, approval_request_json: approval ? JSON.stringify(approval) : null,
    swap_request_id: swap.requestId, swap_request_json: JSON.stringify(swap),
    approval_operation_json: null, swap_operation_json: null,
    phase: "queued", revision: "0", created_at: "100", updated_at: "100",
  };
}

function receipt(patch: Partial<EvmReceipt> = {}): EvmReceipt {
  return { blockNumber: "21000001", blockHash: BLOCK_HASH, status: "success", gasUsed: "123456", effectiveGasPriceWei: "2500000000", logs: [], finality: "included", observedAtNs: "1800000000000000000", ...patch };
}
function operation(stage: "approval" | "swap" = "swap", patch: Partial<EvmOperationResult> = {}): EvmOperationResult {
  return { requestId: stage === "approval" ? APPROVAL_ID : SWAP_ID, accountId: "main", chainId: "1", operationId: stage === "approval" ? "10" : "11", kind: "transaction", status: "submitted", address: ACCOUNT.toLowerCase(), transactionHash: HASH, signature: null, message: null, reviewRevision: "1", receipt: null, ...patch };
}
function confirmed(stage: "approval" | "swap" = "swap", patch: Partial<EvmReceipt> = {}): EvmOperationResult {
  return operation(stage, { status: "confirmed", receipt: receipt(patch) });
}

function memoryStore(initial: SwapRecord, events: string[] = []) {
  let current = structuredClone(initial);
  const updates: { stage: string; phase: string; operation: EvmOperationResult | null }[] = [];
  const store: Store = {
    async page() { return { rows: [structuredClone(current)], nextCursor: null }; },
    async list() { return [structuredClone(current)]; },
    async get(id) { return id === current.id ? structuredClone(current) : null; },
    async begin() { throw new Error("Unexpected begin in a saved-intent workflow"); },
    async update(saved, stage, phase, result = null) {
      if (saved.id !== current.id || saved.revision !== current.revision) throw new Error("Journal revision conflict");
      events.push(`persist:${phase}`);
      updates.push({ stage, phase, operation: structuredClone(result) });
      current = {
        ...current, phase, revision: String(BigInt(current.revision) + 1n), updated_at: String(BigInt(current.updated_at) + 1n),
        approval_operation_json: stage === "approval" && result ? JSON.stringify(result) : current.approval_operation_json,
        swap_operation_json: stage === "swap" && result ? JSON.stringify(result) : current.swap_operation_json,
      };
      return structuredClone(current);
    },
  };
  return { store, updates, current: () => structuredClone(current) };
}

function walletMock(options: {
  account?: EvmAccount | null;
  status?: (request: EvmOperationStatusRequest) => EvmOperationStatusResult | Promise<EvmOperationStatusResult>;
  send?: (request: EvmSendTransactionRequest) => EvmOperationResult | Promise<EvmOperationResult>;
  transaction?: (request: EvmTransactionRequest) => EvmTransactionResult | Promise<EvmTransactionResult>;
  replacement?: (request: EvmReplacementTransactionRequest) => EvmReplacementTransactionResult | Promise<EvmReplacementTransactionResult>;
  events?: string[];
} = {}) {
  const sends: EvmSendTransactionRequest[] = [], statuses: EvmOperationStatusRequest[] = [], transactionReads: EvmTransactionRequest[] = [], replacementReads: EvmReplacementTransactionRequest[] = [];
  const wallet = {
    async accounts() { return { accounts: options.account === null ? [] : [{ ...(options.account ?? account) }] }; },
    async operationStatus(request: EvmOperationStatusRequest) {
      statuses.push(structuredClone(request)); options.events?.push("wallet:status");
      return options.status ? await options.status(request) : { ...request, status: "not_found" };
    },
    async sendTransaction(request: EvmSendTransactionRequest) {
      sends.push(structuredClone(request)); options.events?.push("wallet:send");
      return options.send ? await options.send(request) : operation(request.requestId === APPROVAL_ID ? "approval" : "swap");
    },
    async transaction(request: EvmTransactionRequest) {
      transactionReads.push(structuredClone(request));
      if (!options.transaction) throw new Error("Unexpected transaction evidence read");
      // Keep the mock on the real SDK's contract: its public RPC method parses
      // and binds the evidence to the requested network and hash.
      return parseEvmTransactionResult(await options.transaction(request), request);
    },
    async replacementTransaction(request: EvmReplacementTransactionRequest) {
      replacementReads.push(structuredClone(request));
      if (!options.replacement) throw new Error("Unexpected replacement proof read");
      return parseEvmReplacementTransactionResult(await options.replacement(request), request);
    },
  } as unknown as EvmWalletClient;
  return { wallet, sends, statuses, transactionReads, replacementReads };
}

function evidence(saved: SwapRecord, stage: "approval" | "swap" = "swap", actualReceipt: EvmReceipt | null = receipt()): EvmTransactionResult {
  const request = JSON.parse((stage === "approval" ? saved.approval_request_json : saved.swap_request_json)!);
  return { chainId: saved.chain_id, transactionHash: HASH, walletRequestMatches: true, transaction: { from: ACCOUNT, to: request.to, data: request.data, valueWei: request.valueWei, nonce: "17", blockNumber: actualReceipt?.blockNumber ?? null, blockHash: actualReceipt?.blockHash ?? null }, receipt: actualReceipt, observedAtNs: "1800000000000000001", source: "evm_rpc" };
}
function replacementProof(request: EvmReplacementTransactionRequest, matches = true): EvmReplacementTransactionResult {
  return { ...request, walletReplacementMatches: matches, observedAtNs: "1800000000000000001", source: "evm_wallet_journal" };
}

test("the backend adapter omits absent Candid input fields and recovers a lost begin reply using the same wallet request", async () => {
  const savedIntent = intent();
  let persisted: Record<string, unknown> | null = null, writes = 0;
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      checkMethodInput(method, args);
      if (method === "uniswap_get_v1") { expect(args).toEqual(["durable-swap"]); return checkMethodOutput(method, persisted); }
      throw new Error(`Unexpected query ${method}`);
    },
    async updateSelf(method: string, args: unknown[]) {
      checkMethodInput(method, args);
      writes++;
      expect(method).toBe("uniswap_begin_v1");
      const input = args[0] as SwapRecord;
      expect(Object.hasOwn(input, "approval_request_id")).toBe(false); expect(Object.hasOwn(input, "approval_request_json")).toBe(false);
      expect(input.chain_id).toBe("1");
      persisted = { ...input, phase: "queued", revision: "0", created_at: "100", updated_at: "100" };
      checkMethodOutput(method, persisted);
      throw new Error("Reply lost after durable begin");
    },
  };
  const store = createSwapStore(kernel as unknown as Parameters<typeof createSwapStore>[0]);
  await expect(store.begin(savedIntent, "durable-swap")).rejects.toThrow("Reply lost");
  const recovered = await store.begin(savedIntent, "durable-swap");
  expect(writes).toBe(1); expect(recovered).toEqual(parseSwapRecord(persisted!));
  expect(recovered.approval_request_id).toBeNull(); expect(recovered.approval_operation_json).toBeNull();
  expect(approvalConfirmed(recovered)).toBe(true);
  expect(recovered.swap_request_id).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(recovered.swap_request_json).requestId).toBe(recovered.swap_request_id);
  await expect(store.begin({ ...savedIntent, executionMode: "agent" }, "durable-swap")).rejects.toThrow("different intent");
});

test("the backend adapter sends typed journal identity without absent operation evidence and accepts direct Kernel results", async () => {
  const initial = record(intent({ approval: true }));
  const calls: unknown[][] = [];
  const kernel = {
    async querySelf() { return null; },
    async updateSelf(method: string, args: unknown[]) {
      checkMethodInput(method, args);
      calls.push([method, args]);
      const input = args[0] as { phase: string; expected_revision: string; operation_json?: string };
      return checkMethodOutput(method, wireRecord({ ...initial, phase: input.phase, revision: String(BigInt(input.expected_revision) + 1n), approval_operation_json: input.operation_json ?? null }));
    },
  };
  const store = createSwapStore(kernel as unknown as Parameters<typeof createSwapStore>[0]);
  const saved = await store.update(initial, "approval", "approval_requested");
  expect(saved.revision).toBe("1");
  expect(calls).toEqual([["uniswap_update_v1", [{ id: initial.id, expected_revision: "0", stage: "approval", request_id: APPROVAL_ID, account_id: "main", chain_id: "1", phase: "approval_requested" }]]]);
  expect(saved.approval_operation_json).toBeNull(); expect(saved.swap_operation_json).toBeNull();
  await expect(store.update(initial, "approval", "approval_confirmed", confirmed("swap"))).rejects.toThrow("does not match");
  expect(calls).toHaveLength(1);
  const observed = confirmed("approval");
  const completed = await store.update(saved, "approval", "approval_confirmed", observed);
  expect(completed.approval_operation_json).toBe(JSON.stringify(observed));
  expect(completed.revision).toBe("2"); expect(approvalConfirmed(completed)).toBe(true);
  expect(calls).toHaveLength(2);
});

test("approval and swap receipts fit the real journal transport while preserving every output-token log", async () => {
  let current = record(intent({ approval: true }));
  const kernel = {
    async querySelf() { return wireRecord(current); },
    async updateSelf(method: string, args: unknown[]) {
      checkMethodInput(method, args);
      const input = args[0] as { stage: "approval" | "swap"; operation_json: string; phase: string };
      current = { ...current, [`${input.stage}_operation_json`]: input.operation_json, phase: input.phase, revision: String(BigInt(current.revision) + 1n) };
      const output = wireRecord(current);
      encodeSelfCallValues(output as SelfCallValue);
      return checkMethodOutput(method, output);
    },
  };
  const store = createSwapStore(kernel as unknown as Parameters<typeof createSwapStore>[0]);
  const approval = confirmed("approval", { logs: [transfer(USDC, ROUTER, 1_000_000n, 0)] });
  current = await store.update(current, "approval", "approval_confirmed", approval);
  const swap = confirmed("swap", { logs: [transfer(USDC, ROUTER, 1_000_000n, 0), transfer(WETH, RECIPIENT, 2_000_000n, 1)] });
  current = await store.update(current, "swap", "swap_confirmed", swap);
  expect(JSON.parse(current.approval_operation_json!).receipt.logs).toEqual(approval.receipt!.logs);
  expect(JSON.parse(current.swap_operation_json!).receipt.logs).toEqual(swap.receipt!.logs);
  expect(receivedTokenAtoms(current)).toBe("2000000");
  expect(current.approval_request_id).toBe(APPROVAL_ID);
  expect(current.swap_request_id).toBe(SWAP_ID);
});

test("list and get use generated method schemas and normalize omitted output options", async () => {
  const initial = record();
  const calls: unknown[][] = [];
  const projected = wireRecord(initial);
  expect(Object.hasOwn(projected, "approval_request_id")).toBe(false);
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      checkMethodInput(method, args); calls.push([method, args]);
      if (method === "uniswap_history_v1") return checkMethodOutput(method, { rows: [projected] });
      if (method === "uniswap_get_v1") return checkMethodOutput(method, args[0] === initial.id ? projected : null);
      throw new Error(`Unexpected query ${method}`);
    },
    async updateSelf() { throw new Error("No journal mutation expected"); },
  };
  const store = createSwapStore(kernel as unknown as Parameters<typeof createSwapStore>[0]);
  const listed = await store.list();
  expect(listed).toEqual([initial]); expect(approvalConfirmed(listed[0]!)).toBe(true);
  expect(await store.get(initial.id)).toEqual(initial); expect(await store.get("missing")).toBeNull();
  expect(calls).toEqual([["uniswap_history_v1", [{ limit: "32" }]], ["uniswap_get_v1", [initial.id]], ["uniswap_get_v1", ["missing"]]]);
});

test("lost wallet replies retain the requested phase, then reload reconciles without resending", async () => {
  const events: string[] = [];
  const journal = memoryStore(record(), events);
  let submitted = false;
  const { wallet, sends, statuses } = walletMock({ events,
    status: (request) => submitted ? confirmed() : { ...request, status: "not_found" },
    send: () => { submitted = true; throw new Error("Broker reply lost after broadcast"); },
  });
  await expect(executeStep(wallet, journal.store, journal.current(), "swap")).rejects.toThrow("reply lost");
  expect(events).toEqual(["wallet:status", "persist:swap_requested", "wallet:send"]);
  const afterLoss = journal.current();
  expect(afterLoss.phase).toBe("swap_requested"); expect(afterLoss.swap_operation_json).toBeNull();
  const resumed = await executeStep(wallet, journal.store, afterLoss, "swap");
  expect(resumed.phase).toBe("swap_confirmed"); expect(sends).toHaveLength(1);
  expect(statuses.map(({ requestId }) => requestId)).toEqual([SWAP_ID, SWAP_ID]);
  expect(JSON.parse(resumed.swap_operation_json!)).toMatchObject({ transactionHash: HASH, status: "confirmed" });
});

test("a missing status after a lost reply retries exactly the saved wallet request ID and calldata", async () => {
  const initial = record();
  const journal = memoryStore(initial);
  let first = true;
  const { wallet, sends } = walletMock({ send: () => { if (first) { first = false; throw new Error("Request outcome unknown"); } return operation(); } });
  await expect(executeStep(wallet, journal.store, initial, "swap")).rejects.toThrow("unknown");
  const resumed = await executeStep(wallet, journal.store, journal.current(), "swap");
  expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
  expect(sends[1]).toEqual(JSON.parse(initial.swap_request_json)); expect(resumed.phase).toBe("swap_submitted");
});

test.each([
  "Insufficient native balance for maximum gas fee",
  "Token transfer simulation reverted: insufficient token balance",
  "RPC providers disagree; transaction fee estimate is unavailable",
])("wallet estimation failure preserves completed approval and reconciles the same swap: %s", async (error) => {
  const initial = { ...record(intent({ approval: true })), approval_operation_json: JSON.stringify(confirmed("approval")), phase: "approval_confirmed" };
  const journal = memoryStore(initial);
  let failed = false;
  const { wallet, sends, statuses } = walletMock({
    status: (request) => failed ? operation("swap", { status: "failed", transactionHash: null, message: error }) : { ...request, status: "not_found" },
    send: () => { failed = true; throw new Error(error); },
  });
  await expect(executeStep(wallet, journal.store, initial, "swap")).rejects.toThrow(error);
  const interrupted = journal.current();
  expect(interrupted).toMatchObject({ phase: "swap_requested", quote_json: initial.quote_json, approval_operation_json: initial.approval_operation_json, swap_request_id: SWAP_ID, swap_request_json: initial.swap_request_json, swap_operation_json: null });
  const reloaded = memoryStore(interrupted);
  const reconciled = await executeStep(wallet, reloaded.store, interrupted, "swap");
  expect(reconciled.phase).toBe("swap_failed");
  expect(reconciled.approval_operation_json).toBe(initial.approval_operation_json);
  expect(reconciled.swap_request_json).toBe(initial.swap_request_json);
  expect(statuses.map((request) => request.requestId)).toEqual([SWAP_ID, SWAP_ID]);
  expect(sends).toEqual([JSON.parse(initial.swap_request_json)]);
  expect(effectiveOperation(reconciled, "swap")).toMatchObject({ status: "failed", message: error, receipt: null });
});

test("confirmed approvals are skipped while swap submission waits for their successful receipt", async () => {
  const initial = record(intent({ approval: true }));
  const journal = memoryStore(initial);
  const { wallet, sends } = walletMock({ status: (request) => request.requestId === APPROVAL_ID ? confirmed("approval") : { ...request, status: "not_found" } });
  await expect(executeStep(wallet, journal.store, initial, "swap")).rejects.toThrow("Wait for the approval receipt");
  expect(sends).toHaveLength(0);
  const approved = await executeStep(wallet, journal.store, initial, "approval");
  expect(approvalConfirmed(approved)).toBe(true); expect(sends).toHaveLength(0);
  const result = await executeStep(wallet, journal.store, approved, "swap");
  expect(sends.map(({ requestId }) => requestId)).toEqual([SWAP_ID]);
  expect(result.approval_operation_json).toBe(approved.approval_operation_json);
});

test("a successful exact replacement approval unlocks the saved swap without repeating approval", async () => {
  const initial = record(intent({ approval: true })), journal = memoryStore(initial);
  const original = operation("approval", { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH });
  const replacement = { ...evidence(initial, "approval"), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null };
  const { wallet, sends, transactionReads } = walletMock({
    status: (request) => request.requestId === APPROVAL_ID ? original : { ...request, status: "not_found" },
    transaction: () => replacement,
  });
  const approved = await executeStep(wallet, journal.store, initial, "approval");
  expect(approvalConfirmed(approved)).toBe(true);
  expect(approved.phase).toBe("approval_confirmed");
  expect(sends).toHaveLength(0);
  expect(transactionReads).toEqual([{ chainId: "1", transactionHash: REPLACEMENT_HASH }]);
  const stored = JSON.parse(approved.approval_operation_json!);
  expect(stored).toMatchObject({ requestId: APPROVAL_ID, transactionHash: HASH, status: "replaced", receipt: null, replacementTransactionHash: REPLACEMENT_HASH, replacementEvidence: replacement });
  const reloaded = memoryStore(approved);
  const result = await executeStep(wallet, reloaded.store, approved, "swap");
  expect(sends.map(({ requestId }) => requestId)).toEqual([SWAP_ID]);
  expect(result.approval_operation_json).toBe(approved.approval_operation_json);
});

test.each(["approval", "swap"] as const)("a pending %s replacement is observed through inclusion without repeating either transaction", async (stage) => {
  const initial = record(intent({ approval: stage === "approval" })), journal = memoryStore(initial);
  let mined = false;
  const { wallet, sends, statuses, transactionReads } = walletMock({
    status: () => operation(stage, { status: mined ? "replaced" : "unknown", replacementTransactionHash: REPLACEMENT_HASH }),
    transaction: () => ({ ...evidence(initial, stage, mined ? receipt({ logs: [transfer(USDC, RECIPIENT, 350n, 0), transfer(USDC, OTHER, 999n, 1)] }) : null), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null }),
  });
  const pending = await executeStep(wallet, journal.store, initial, stage);
  expect(pending.phase).toBe(`${stage}_submitted`);
  expect(effectiveOperation(pending, stage)).toMatchObject({ status: "submitted", receipt: null, transactionHash: REPLACEMENT_HASH, source: "replacement" });
  if (stage === "approval") expect(approvalConfirmed(pending)).toBe(false);
  expect(sends).toHaveLength(0);
  mined = true;
  const reloaded = memoryStore(pending);
  const included = await executeStep(wallet, reloaded.store, pending, stage);
  expect(included.phase).toBe(`${stage}_confirmed`);
  expect(effectiveOperation(included, stage)).toMatchObject({ status: "confirmed", receipt: { status: "success" }, transactionHash: REPLACEMENT_HASH, source: "replacement" });
  expect(storedOperation(included, stage)).toMatchObject({ status: "replaced", transactionHash: HASH, receipt: null, replacementTransactionHash: REPLACEMENT_HASH });
  if (stage === "swap") expect(receivedTokenAtoms(included)).toBe("350");
  const again = await executeStep(wallet, reloaded.store, included, stage);
  expect(again.phase).toBe(included.phase);
  expect(sends).toHaveLength(0);
  expect(statuses.map((request) => request.requestId)).toEqual([stage === "approval" ? APPROVAL_ID : SWAP_ID, stage === "approval" ? APPROVAL_ID : SWAP_ID, stage === "approval" ? APPROVAL_ID : SWAP_ID]);
  expect(transactionReads.every((request) => request.transactionHash === REPLACEMENT_HASH && request.walletRequest === undefined)).toBe(true);
});

test.each(["approval", "swap"] as const)("a reverted exact %s replacement remains reverted after reload and cannot complete the step", async (stage) => {
  const initial = record(intent({ approval: stage === "approval" })), journal = memoryStore(initial);
  const { wallet, sends } = walletMock({
    status: () => operation(stage, { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH }),
    transaction: () => ({ ...evidence(initial, stage, receipt({ status: "reverted" })), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null }),
  });
  const observed = await executeStep(wallet, journal.store, initial, stage);
  expect(observed.phase).toBe(`${stage}_reverted`);
  expect(effectiveOperation(observed, stage)).toMatchObject({ status: "reverted", receipt: { status: "reverted" }, source: "replacement" });
  if (stage === "approval") expect(approvalConfirmed(observed)).toBe(false);
  expect(receivedTokenAtoms(observed)).toBeNull();
  const resumed = memoryStore(observed);
  expect((await executeStep(wallet, resumed.store, observed, stage)).phase).toBe(`${stage}_reverted`);
  expect(sends).toHaveLength(0);
});

test.each(["approval", "swap"] as const)("cancelled or changed %s replacements never satisfy the frozen request", async (stage) => {
  for (const changed of [{ to: ACCOUNT, data: "0x", valueWei: "0" }, { from: OTHER }, { to: OTHER }, { data: "0x1234" }, { valueWei: "17" }]) {
    const initial = record(intent({ approval: stage === "approval" })), journal = memoryStore(initial);
    const actual = evidence(initial, stage);
    Object.assign(actual.transaction!, changed);
    const { wallet, sends } = walletMock({
      status: () => operation(stage, { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH }),
      transaction: () => ({ ...actual, transactionHash: REPLACEMENT_HASH, walletRequestMatches: null }),
    });
    const observed = await executeStep(wallet, journal.store, initial, stage);
    expect(observed.phase).toBe(`${stage}_replaced`);
    expect(effectiveOperation(observed, stage)).toMatchObject({ status: "replaced", receipt: null, source: "replacement" });
    expect(effectiveOperation(observed, stage)?.message).toContain("does not execute the saved");
    if (stage === "approval") expect(approvalConfirmed(observed)).toBe(false);
    expect(receivedTokenAtoms(observed)).toBeNull();
    expect(sends).toHaveLength(0);
  }
});

test("missing replacement evidence stays unresolved and mismatched hashes or networks are never saved", async () => {
  const initial = record(), journal = memoryStore(initial);
  const original = operation("swap", { status: "unknown", replacementTransactionHash: REPLACEMENT_HASH });
  const absent = walletMock({ status: () => original, transaction: () => ({ ...evidence(initial, "swap", null), transaction: null, transactionHash: REPLACEMENT_HASH, walletRequestMatches: null }) });
  const pending = await executeStep(absent.wallet, journal.store, initial, "swap");
  expect(pending.phase).toBe("swap_unknown");
  expect(effectiveOperation(pending, "swap")?.receipt).toBeNull();
  expect(absent.sends).toHaveLength(0);
  for (const changed of [{ transactionHash: HASH }, { chainId: "42161" }]) {
    const fresh = memoryStore(initial);
    const mismatch = walletMock({ status: () => original, transaction: () => ({ ...evidence(initial), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null, ...changed }) });
    await expect(executeStep(mismatch.wallet, fresh.store, initial, "swap")).rejects.toThrow("evidence does not match");
    expect(fresh.updates).toHaveLength(0); expect(mismatch.sends).toHaveLength(0);
  }
  const invalid = walletMock({ status: () => ({ ...original, replacementTransactionHash: "0x12" }) });
  await expect(executeStep(invalid.wallet, memoryStore(initial).store, initial, "swap")).rejects.toThrow();
  expect(invalid.transactionReads).toHaveLength(0);
});

test("saved replacement proof is bound to the original linkage and untrusted claims cannot inject it", async () => {
  const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
  const original = operation("swap", { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH });
  const injected = { ...original, replacementEvidence: { ...evidence(initial), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null } };
  const { wallet, transactionReads } = walletMock();
  await expect(verifyAgentResult(wallet, journal.store, initial, "swap", injected)).rejects.toThrow();
  expect(transactionReads).toHaveLength(0); expect(journal.updates).toHaveLength(0);
  const human = record();
  const wrong = { ...human, swap_operation_json: JSON.stringify({ ...injected, replacementEvidence: { ...injected.replacementEvidence, transactionHash: HASH } }) };
  expect(() => storedOperation(wrong, "swap")).toThrow("evidence does not match");
});

test("rejected or reverted wallet operations remain terminal for that saved request", async () => {
  for (const state of [operation("swap", { status: "rejected", transactionHash: null, message: "Owner declined" }), operation("swap", { status: "reverted", receipt: receipt({ status: "reverted" }) })]) {
    const initial = record();
    const journal = memoryStore(initial);
    const { wallet, sends } = walletMock({ status: () => state });
    const result = await executeStep(wallet, journal.store, initial, "swap");
    expect(sends).toHaveLength(0); expect(result.phase).toBe(`swap_${state.status}`);
  }
});

test("expired saved swaps reconcile existing chain work but cannot dispatch a fresh transaction", async () => {
  const initial = record(intent({ expired: true }));
  const journal = memoryStore(initial);
  const missing = walletMock();
  await expect(executeStep(missing.wallet, journal.store, initial, "swap")).rejects.toThrow("deadline has expired");
  expect(missing.sends).toHaveLength(0);
  const complete = walletMock({ status: () => confirmed() });
  const result = await executeStep(complete.wallet, journal.store, initial, "swap");
  expect(result.phase).toBe("swap_confirmed"); expect(complete.sends).toHaveLength(0);
});

test("human execution does not forward an Agent workflow into the wallet", async () => {
  const initial = record(intent({ mode: "agent" }));
  const journal = memoryStore(initial), { wallet, sends, statuses } = walletMock();
  await expect(executeStep(wallet, journal.store, initial, "swap")).rejects.toThrow("root agent must call EVM Wallet directly");
  expect(sends).toHaveLength(0); expect(statuses).toHaveLength(0); expect(journal.updates).toHaveLength(0);
});

test("replacement signing fingerprints, namespaces, addresses, or missing accounts stop before status or dispatch", async () => {
  for (const replacement of [
    { ...account, keyFingerprint: `0x${"88".repeat(32)}` }, { ...account, namespaceVersion: "2" },
    { ...account, address: OTHER }, null,
  ]) {
    const initial = record(), journal = memoryStore(initial);
    const { wallet, sends, statuses } = walletMock({ account: replacement });
    await expect(executeStep(wallet, journal.store, initial, "swap")).rejects.toThrow("signing identity changed");
    expect(sends).toHaveLength(0); expect(statuses).toHaveLength(0); expect(journal.updates).toHaveLength(0);
  }
});

test("wallet operations are bound to saved request, account, network, address, and transaction kind", () => {
  const initial = record();
  const mismatches: unknown[] = [
    operation("swap", { requestId: OTHER_ID }), operation("swap", { chainId: "42161" }),
    { ...operation(), accountId: "other" }, operation("swap", { address: OTHER }),
    operation("swap", { kind: "message", status: "prepared", transactionHash: null }),
  ];
  expect(validateOperation(initial, "swap", confirmed()).requestId).toBe(SWAP_ID);
  for (const wrong of mismatches) expect(() => validateOperation(initial, "swap", wrong)).toThrow();
});

test("a mismatched status is never persisted, even if it claims success", async () => {
  const initial = record(), journal = memoryStore(initial);
  const { wallet, sends } = walletMock({ status: () => confirmed("approval") });
  await expect(reconcileStep(wallet, journal.store, initial, "swap")).rejects.toThrow("does not match");
  expect(journal.updates).toHaveLength(0); expect(sends).toHaveLength(0);
});

test("modified saved swap calldata and exact approval amounts fail before dispatch", async () => {
  const initial = record(intent({ approval: true }));
  const modifiedSwap = { ...initial, swap_request_json: JSON.stringify({ ...JSON.parse(initial.swap_request_json), data: "0x1234" }) };
  expect(() => savedIntent(modifiedSwap)).toThrow("does not match its quote");
  const modifiedApproval = { ...initial, approval_request_json: JSON.stringify({ ...JSON.parse(initial.approval_request_json!), data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [ROUTER, 2n ** 256n - 1n] }) }) };
  const journal = memoryStore(modifiedApproval), { wallet, sends } = walletMock();
  await expect(executeStep(wallet, journal.store, modifiedApproval, "approval")).rejects.toThrow("exact quoted amount and spender");
  expect(sends).toHaveLength(0); expect(journal.updates).toHaveLength(0);
});

describe("independent Agent result verification", () => {
  test.each(["approval", "swap"] as const)("a Wallet-proven %s replacement is verified even when the original transaction is no longer visible", async (stage) => {
    const initial = record(intent({ mode: "agent", approval: stage === "approval" })), journal = memoryStore(initial);
    const original = operation(stage, { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH });
    const replacement = { ...evidence(initial, stage), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null };
    const { wallet, transactionReads, replacementReads, sends, statuses } = walletMock({
      transaction: (request) => request.transactionHash === HASH ? { ...evidence(initial, stage, null), transaction: null } : replacement,
      replacement: (request) => replacementProof(request),
    });
    const verified = await verifyAgentResult(wallet, journal.store, initial, stage, original);
    expect(verified.phase).toBe(`${stage}_confirmed`);
    const requestId = stage === "approval" ? APPROVAL_ID : SWAP_ID;
    expect(transactionReads).toEqual([
      { chainId: "1", transactionHash: HASH, walletRequest: { callerAppId: "agent", callerInstallationUid: "17", requestId } },
      { chainId: "1", transactionHash: REPLACEMENT_HASH },
    ]);
    expect(replacementReads).toEqual([{ chainId: "1", transactionHash: REPLACEMENT_HASH, originalWalletRequest: { callerAppId: "agent", callerInstallationUid: "17", requestId } }]);
    expect(storedOperation(verified, stage)).toMatchObject({ requestId, transactionHash: HASH, receipt: null, status: "replaced", replacementEvidence: { ...replacement, walletReplacementProof: replacementProof(replacementReads[0]!) } });
    expect(effectiveOperation(structuredClone(verified), stage)).toMatchObject({ status: "confirmed", transactionHash: REPLACEMENT_HASH, source: "replacement", receipt: { status: "success" } });
    if (stage === "approval") expect(approvalConfirmed(structuredClone(verified))).toBe(true);
    expect(sends).toHaveLength(0); expect(statuses).toHaveLength(0);
  });

  test("Agent replacement claims require both exact original binding and a separately proven replacement relationship", async () => {
    const original = operation("swap", { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH });
    for (const originalMatches of [false, null]) {
      const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
      const { wallet, replacementReads } = walletMock({ transaction: () => ({ ...evidence(initial, "swap", null), walletRequestMatches: originalMatches }) });
      await expect(verifyAgentResult(wallet, journal.store, initial, "swap", original)).rejects.toThrow();
      expect(replacementReads).toHaveLength(0); expect(journal.updates).toHaveLength(0);
    }
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const { wallet, transactionReads } = walletMock({ transaction: () => evidence(initial, "swap", null), replacement: (request) => replacementProof(request, false) });
    await expect(verifyAgentResult(wallet, journal.store, initial, "swap", original)).rejects.toThrow("did not prove the replacement relationship");
    expect(transactionReads).toHaveLength(1); expect(journal.updates).toHaveLength(0);
  });

  test("replacement proofs for a different caller, request, chain or hash cannot be recorded", async () => {
    const original = operation("swap", { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH });
    for (const changed of [
      { chainId: "42161" }, { transactionHash: HASH },
      { originalWalletRequest: { callerAppId: "uniswap", callerInstallationUid: "17", requestId: SWAP_ID } },
      { originalWalletRequest: { callerAppId: "agent", callerInstallationUid: "18", requestId: SWAP_ID } },
      { originalWalletRequest: { callerAppId: "agent", callerInstallationUid: "17", requestId: OTHER_ID } },
    ]) {
      const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
      const { wallet, transactionReads } = walletMock({ transaction: () => evidence(initial, "swap", null), replacement: (request) => ({ ...replacementProof(request), ...changed }) });
      await expect(verifyAgentResult(wallet, journal.store, initial, "swap", original)).rejects.toThrow("proof does not match");
      expect(transactionReads).toHaveLength(1); expect(journal.updates).toHaveLength(0);
    }
  });

  test("a proven Agent replacement still needs the exact saved execution and a successful receipt", async () => {
    for (const outcome of ["missing", "pending", "cancel", "reverted"] as const) {
      const initial = record(intent({ mode: "agent", approval: true })), journal = memoryStore(initial);
      const original = operation("approval", { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH });
      const replacement = { ...evidence(initial, "approval", outcome === "pending" || outcome === "missing" ? null : receipt({ status: outcome === "reverted" ? "reverted" : "success" })), transactionHash: REPLACEMENT_HASH, walletRequestMatches: null };
      if (outcome === "missing") replacement.transaction = null;
      if (outcome === "cancel") Object.assign(replacement.transaction!, { to: ACCOUNT, data: "0x", valueWei: "0" });
      const { wallet, sends } = walletMock({ transaction: (request) => request.transactionHash === HASH ? evidence(initial, "approval", null) : replacement, replacement: (request) => replacementProof(request) });
      const result = await verifyAgentResult(wallet, journal.store, initial, "approval", original);
      expect(result.phase).toBe(`approval_${outcome === "missing" ? "unknown" : outcome === "pending" ? "submitted" : outcome === "cancel" ? "replaced" : "reverted"}`);
      expect(approvalConfirmed(result)).toBe(false);
      expect(sends).toHaveLength(0);
    }
  });

  test("the original canonical receipt wins over an unproved Agent replacement claim", async () => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const { wallet, replacementReads } = walletMock({ transaction: () => evidence(initial) });
    const result = await verifyAgentResult(wallet, journal.store, initial, "swap", operation("swap", { status: "replaced", replacementTransactionHash: REPLACEMENT_HASH }));
    expect(result.phase).toBe("swap_confirmed");
    expect(storedOperation(result, "swap")).toMatchObject({ transactionHash: HASH, replacementTransactionHash: null, receipt: { status: "success" } });
    expect(replacementReads).toHaveLength(0);
  });

  test.each(["from", "to", "data", "valueWei"] as const)("rejects a public transaction whose %s differs despite a claimed successful receipt", async (field) => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const actual = evidence(initial);
    actual.transaction![field] = field === "data" ? "0x1234" : field === "valueWei" ? "0" : OTHER;
    const { wallet, transactionReads } = walletMock({ transaction: () => actual });
    await expect(verifyAgentResult(wallet, journal.store, initial, "swap", confirmed())).rejects.toThrow("On-chain transaction does not match");
    expect(transactionReads).toEqual([{ chainId: "1", transactionHash: HASH, walletRequest: { callerAppId: "agent", callerInstallationUid: "17", requestId: SWAP_ID } }]); expect(journal.updates).toHaveLength(0);
  });

  test("the SDK binds independent evidence to the requested chain and transaction hash", async () => {
    for (const changed of [{ chainId: "42161" }, { transactionHash: `0x${"aa".repeat(32)}` }]) {
      const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
      const { wallet } = walletMock({ transaction: () => ({ ...evidence(initial), ...changed }) });
      await expect(verifyAgentResult(wallet, journal.store, initial, "swap", confirmed())).rejects.toThrow("evidence does not match");
      expect(journal.updates).toHaveLength(0);
    }
  });

  test("the independently read receipt replaces a fake claimed receipt and status", async () => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const actualReceipt = receipt({ status: "reverted", gasUsed: "33333", finality: "safe" });
    const { wallet } = walletMock({ transaction: () => evidence(initial, "swap", actualReceipt) });
    const result = await verifyAgentResult(wallet, journal.store, initial, "swap", confirmed("swap", { gasUsed: "1", finality: "finalized" }));
    const recorded = parseEvmOperationResult(JSON.parse(result.swap_operation_json!));
    expect(recorded.status).toBe("reverted"); expect(recorded.receipt).toEqual(actualReceipt); expect(recorded.signature).toBeNull();
    expect(result.phase).toBe("swap_reverted");
  });

  test("a visible pending transaction clears a fake claimed receipt without declaring completion", async () => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const { wallet } = walletMock({ transaction: () => evidence(initial, "swap", null) });
    const result = await verifyAgentResult(wallet, journal.store, initial, "swap", confirmed());
    expect(JSON.parse(result.swap_operation_json!)).toMatchObject({ status: "submitted", receipt: null, transactionHash: HASH });
    expect(result.phase).toBe("swap_submitted");
  });

  test("missing public transactions and claims without a hash stay unresolved", async () => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const { wallet, transactionReads } = walletMock({ transaction: () => ({ ...evidence(initial, "swap", null), transaction: null }) });
    await expect(verifyAgentResult(wallet, journal.store, initial, "swap", operation("swap", { status: "unknown", transactionHash: null }))).rejects.toThrow("No transaction hash");
    expect(transactionReads).toHaveLength(0);
    await expect(verifyAgentResult(wallet, journal.store, initial, "swap", confirmed())).rejects.toThrow("not yet visible");
    expect(journal.updates).toHaveLength(0);
  });

  test.each([false, null])("a wallet request match of %s cannot complete an otherwise identical confirmed transaction", async (walletRequestMatches) => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    const { wallet, transactionReads } = walletMock({ transaction: () => ({ ...evidence(initial), walletRequestMatches }) });
    await expect(verifyAgentResult(wallet, journal.store, initial, "swap", confirmed())).rejects.toThrow();
    expect(transactionReads).toEqual([{ chainId: "1", transactionHash: HASH, walletRequest: { callerAppId: "agent", callerInstallationUid: "17", requestId: SWAP_ID } }]);
    expect(journal.updates).toHaveLength(0); expect(journal.current()).toEqual(initial);
  });

  test("an earlier identical transaction relabeled as the current request remains unresolved", async () => {
    const initial = record(intent({ mode: "agent" })), journal = memoryStore(initial);
    // These public fields and successful receipt really exist, but the wallet
    // journal associates the hash with a different prior request. A claim that
    // simply copies the current request ID must not complete a new intent.
    const priorRequestId = OTHER_ID;
    const { wallet, transactionReads } = walletMock({ transaction: (request) => ({ ...evidence(initial), walletRequestMatches: request.walletRequest?.requestId === priorRequestId }) });
    const relabeled = { ...confirmed(), operationId: "999" };
    await expect(verifyAgentResult(wallet, journal.store, initial, "swap", relabeled)).rejects.toThrow("exact saved caller and request ID");
    expect(transactionReads[0]?.walletRequest).toEqual({ callerAppId: "agent", callerInstallationUid: "17", requestId: SWAP_ID });
    expect(journal.updates).toHaveLength(0); expect(journal.current().swap_operation_json).toBeNull();
  });

  test("an approval binding comes from its saved caller and approval ID rather than the swap ID or claimed operation number", async () => {
    const prepared = intent({ mode: "agent", approval: true });
    prepared.walletCaller = { appId: "agent", installationUid: "29" };
    const initial = record(prepared), journal = memoryStore(initial);
    const { wallet, transactionReads } = walletMock({ transaction: () => evidence(initial, "approval") });
    const result = await verifyAgentResult(wallet, journal.store, initial, "approval", { ...confirmed("approval"), operationId: "999" });
    expect(transactionReads).toEqual([{ chainId: "1", transactionHash: HASH, walletRequest: { callerAppId: "agent", callerInstallationUid: "29", requestId: APPROVAL_ID } }]);
    expect(approvalConfirmed(result)).toBe(true); expect(result.swap_operation_json).toBeNull();
  });

  test("saved Agent intents without a caller identity do not invent an origin", async () => {
    for (const absent of [null, undefined]) {
      const prepared = intent({ mode: "agent" });
      const stored = { ...prepared, walletCaller: absent };
      const initial = { ...record(prepared), quote_json: JSON.stringify(stored) }, journal = memoryStore(initial);
      const { wallet, transactionReads, sends } = walletMock({ transaction: () => evidence(initial) });
      await expect(verifyAgentResult(wallet, journal.store, initial, "swap", confirmed())).rejects.toThrow("caller identity is unavailable");
      expect(transactionReads).toHaveLength(0); expect(sends).toHaveLength(0); expect(journal.updates).toHaveLength(0);
    }
  });
});

function transfer(token: string, to: string, amount: bigint, index: number): EvmReceiptLog {
  return { address: token, data: encodeAbiParameters([{ type: "uint256" }], [amount]), topics: encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: ROUTER, to: to as Hex } }) as string[], logIndex: String(index) };
}

test("received output counts only output-token Transfer logs to the requested recipient", () => {
  const initial = record();
  const logs: EvmReceiptLog[] = [
    transfer(USDC, RECIPIENT, 100n, 0), transfer(USDC, RECIPIENT, 250n, 1),
    transfer(WETH, RECIPIENT, 999n, 2), transfer(USDC, OTHER, 888n, 3),
    { address: USDC, data: "0x12", topics: [], logIndex: "4" },
    { address: USDC, data: "0x", topics: [`0x${"00".repeat(32)}`], logIndex: "5" },
  ];
  const completed = { ...initial, swap_operation_json: JSON.stringify(confirmed("swap", { logs })) };
  expect(receivedTokenAtoms(completed)).toBe("350");
  expect(receivedTokenAtoms(initial)).toBeNull();
  expect(receivedTokenAtoms({ ...initial, swap_operation_json: JSON.stringify(operation("swap", { status: "reverted", receipt: receipt({ status: "reverted", logs }) })) })).toBeNull();
});

test("the wallet reader surfaces a different observation block instead of calculating a misleading price impact", async () => {
  const requests: unknown[] = [];
  const wallet = { async callContract(request: unknown) { requests.push(request); return { result: "0x1234", blockNumber: "100", observedAtNs: "1234567000000" }; } } as unknown as EvmWalletClient;
  const read = walletReader(wallet, "main");
  expect(await read("1", ROUTER, "0x", "0x64")).toEqual({ data: "0x1234", blockNumber: "100", observedAtMs: 1234567 });
  expect(requests).toEqual([{ accountId: "main", chainId: "1", to: ROUTER, data: "0x", blockTag: "0x64" }]);
  await expect(read("1", ROUTER, "0x", "0x63")).rejects.toThrow("different blocks");
});
