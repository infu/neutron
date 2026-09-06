import { expect, test } from "bun:test";
import { encodeFunctionResult, getAddress } from "viem";
import type {
  EvmAccount, EvmOperationResult, EvmOperationStatusRequest, EvmReceipt,
  EvmSendTransactionRequest, EvmWalletClient,
} from "neutron-tools/evm_wallet";
import { createSwapStore, savedIntent, type SavedIntent, type SwapRecord } from "../src/controller.ts";
import { parseProviderSwapInput, providerAttemptId, runProviderSwap } from "../src/provider_flow.ts";
import { defaultTokens, prepareSwap, QUOTER, ROUTER, TOKEN_ABI, type Quote } from "../src/swap.ts";

const address = getAddress("0x1111111111111111111111111111111111111111");
const caller = { appId: "agent", installationUid: "17" };
const tokens = defaultTokens("1");
const input = parseProviderSwapInput({ swapId: "ab".repeat(16), chainId: "1", tokenIn: tokens[1]!.address, tokenOut: null, amountIn: "3000000" });
const account: EvmAccount = { accountId: "main", address, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" };
const receipt: EvmReceipt = { blockNumber: "21000001", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1800000000000000000", logs: [] };
type Stage = "approval" | "swap";

function fixture(initialAllowance = 0n) {
  const records = new Map<string, SwapRecord>(), operations = new Map<string, EvmOperationResult>();
  const sends: EvmSendTransactionRequest[] = [], events: string[] = [], prepared: SavedIntent[] = [], allowanceReads: bigint[] = [];
  let now = Date.now(), allowance = initialAllowance, validitySeconds = 1200, rootCalls = 0;
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      if (method !== "uniswap_get_v1") throw new Error(`Unexpected query ${method}`);
      return structuredClone(records.get(String(args[0])) ?? null);
    },
    async updateSelf(method: string, args: unknown[]) {
      const patch = args[0] as Record<string, string>;
      if (method === "uniswap_begin_v1") {
        if (records.has(patch.id!)) throw new Error("Duplicate immutable intent");
        const record = { ...patch, approval_request_id: patch.approval_request_id ?? null, approval_request_json: patch.approval_request_json ?? null, approval_operation_json: null, swap_operation_json: null, phase: "queued", revision: "0", created_at: "1", updated_at: "1" } as SwapRecord;
        records.set(record.id, structuredClone(record)); events.push(`begin:${record.id}`);
        return structuredClone(record);
      }
      if (method !== "uniswap_update_v1") throw new Error(`Unexpected update ${method}`);
      const current = records.get(patch.id!)!;
      if (!current || current.revision !== patch.expected_revision) throw new Error("Journal revision conflict");
      const next = { ...current, phase: patch.phase!, revision: String(BigInt(current.revision) + 1n), updated_at: String(BigInt(current.updated_at) + 1n), ...(patch.operation_json ? { [`${patch.stage}_operation_json`]: patch.operation_json } : {}) };
      records.set(next.id, next); events.push(`persist:${next.phase}`);
      return structuredClone(next);
    },
  };
  // Exercise the actual journal adapter, request allocation and validation.
  const store = createSwapStore(kernel as unknown as Parameters<typeof createSwapStore>[0]);
  const stage = (request: Pick<EvmSendTransactionRequest, "requestId">): Stage => [...records.values()].some((record) => record.approval_request_id === request.requestId) ? "approval" : "swap";
  function operation(request: EvmSendTransactionRequest, status: EvmOperationResult["status"] = "submitted"): EvmOperationResult {
    return { requestId: request.requestId, accountId: request.accountId, chainId: request.chainId, operationId: String(sends.length), kind: "transaction", status, address, transactionHash: ["submitted", "confirmed", "signed"].includes(status) ? `0x${(stage(request) === "approval" ? "aa" : "bb").repeat(32)}` : null, signature: null, reviewRevision: "1", message: null, receipt: status === "confirmed" ? receipt : null };
  }
  let onSend = async (request: EvmSendTransactionRequest) => operation(request);
  let onWait = async () => {
    events.push("wait");
    for (const [id, pending] of operations) {
      if (pending.status !== "submitted") continue;
      operations.set(id, { ...pending, status: "confirmed", receipt });
      if (stage(pending) === "approval") allowance = BigInt(input.amountIn);
    }
  };
  const wallet = {
    async accounts() { events.push("wallet:accounts"); return { accounts: [account] }; },
    async operationStatus(request: EvmOperationStatusRequest) {
      events.push(`wallet:status:${stage(request)}`);
      return structuredClone(operations.get(request.requestId) ?? { ...request, status: "not_found" });
    },
    async sendTransaction(request: EvmSendTransactionRequest) {
      sends.push(structuredClone(request)); events.push(`wallet:send:${stage(request)}`);
      const result = await onSend(request); operations.set(request.requestId, result); return result;
    },
    async sendTransactionRoot() { rootCalls += 1; throw new Error("Provider flows must use the public Wallet review tool"); },
  } as unknown as EvmWalletClient;
  const options = {
    now: () => now,
    async wait() { await onWait(); },
    async prepare(_wallet: EvmWalletClient, requested: typeof input): Promise<SavedIntent> {
      events.push("prepare");
      const quote: Quote = {
        chainId: requested.chainId, accountId: requested.accountId, accountAddress: address,
        tokenIn: tokens[1]!, tokenOut: tokens[0]!, amountIn: requested.amountIn, amountOut: "900000000000000", minimumOut: "895500000000000",
        recipient: address, slippageBps: requested.slippageBps, deadline: String(Math.floor(now / 1000) + validitySeconds),
        router: ROUTER, quoter: QUOTER, fee: 500, gasEstimate: "90000", priceImpactBps: "10", quotedAtMs: now, blockNumber: "21000000", pool: address, routeWarnings: [],
      };
      const result: SavedIntent = { ...await prepareSwap(async () => {
        allowanceReads.push(allowance);
        return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName: "allowance", result: allowance }), blockNumber: "21000000", observedAtMs: now };
      }, quote, now), account, executionMode: "provider", walletCaller: null };
      prepared.push(structuredClone(result));
      return result;
    },
  };
  return {
    wallet, store, records, operations, sends, events, prepared, allowanceReads, options, operation, stage,
    rootCalls: () => rootCalls,
    advance(ms: number) { now += ms; }, validity(seconds: number) { validitySeconds = seconds; },
    sendWith(callback: typeof onSend) { onSend = callback; }, waitWith(callback: typeof onWait) { onWait = callback; },
    confirmPending: onWait,
    run(extra: Partial<typeof options> & { signal?: AbortSignal } = {}) { return runProviderSwap(wallet, store, input, caller, true, { ...options, ...extra }); },
  };
}

test("one provider call persists exact public Wallet approvals and waits for both receipts before completing", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.state).toBe("complete"); expect(result.transactionHash).toBe(`0x${"bb".repeat(32)}`);
  expect(f.sends.map(f.stage)).toEqual(["approval", "swap"]); expect(f.rootCalls()).toBe(0);
  expect(f.events.indexOf("persist:approval_confirmed")).toBeLessThan(f.events.indexOf("wallet:send:swap"));
  expect(f.events.filter((event) => event === "wait")).toHaveLength(2);
  const record = f.records.get(input.swapId)!;
  expect(JSON.parse(record.approval_request_json!)).toEqual(f.sends[0]);
  expect(JSON.parse(record.swap_request_json)).toEqual(f.sends[1]);
  expect(record.phase).toBe("swap_confirmed"); expect(savedIntent(record).executionMode).toBe("provider");
});

test("an expired approved 3 USDC quote creates one immutable successor and resumes that successor without approving again", async () => {
  const f = fixture(); f.validity(10);
  f.waitWith(async () => { await f.confirmPending(); f.advance(20_000); f.validity(1200); });
  const result = await f.run();
  const successorId = providerAttemptId(input.swapId, "1");
  expect(result.state).toBe("complete"); expect(result.swapId).toBe(successorId);
  expect([...f.records.keys()]).toEqual([input.swapId, successorId]);
  const predecessor = f.records.get(input.swapId)!, successor = f.records.get(successorId)!;
  expect(savedIntent(predecessor).quote).toEqual(f.prepared[0]!.quote);
  expect(predecessor.swap_operation_json).toBeNull(); expect(predecessor.phase).toBe("approval_confirmed");
  expect(successor.approval_request_id).toBeNull(); expect(successor.swap_request_id).not.toBe(predecessor.swap_request_id);
  expect(savedIntent(successor).providerFlow?.attempt).toBe("1");
  expect(f.allowanceReads).toEqual([0n, 3_000_000n]); expect(f.sends.map(f.stage)).toEqual(["approval", "swap"]);
  const retry = await f.run();
  expect(retry).toEqual(result); expect(f.prepared).toHaveLength(2); expect(f.sends).toHaveLength(2);
});

test("a lost swap reply returns a recoverable same-ID flow and retry reconciles its receipt without resending", async () => {
  const f = fixture(3_000_000n);
  f.sendWith(async (request) => { f.operations.set(request.requestId, f.operation(request)); throw new Error("Reply lost after broadcast"); });
  const pending = await f.run();
  const saved = structuredClone(f.records.get(input.swapId)!);
  expect(pending.state).toBe("pending"); expect(pending.swapId).toBe(input.swapId);
  expect(saved.phase).toBe("swap_requested"); expect(saved.swap_operation_json).toBeNull();
  const submitted = f.operations.get(saved.swap_request_id)!;
  f.operations.clear();
  f.advance(1_300_000);
  const unresolved = await f.run();
  expect(unresolved.state).toBe("pending"); expect(unresolved.swapId).toBe(input.swapId);
  expect(f.records.size).toBe(1); expect(f.sends).toHaveLength(1);
  f.operations.set(saved.swap_request_id, { ...submitted, status: "confirmed", receipt });
  const complete = await f.run();
  expect(complete.state).toBe("complete"); expect(f.sends).toHaveLength(1); expect(f.records.size).toBe(1);
  expect(f.records.get(input.swapId)!.swap_request_id).toBe(saved.swap_request_id); expect(f.prepared).toHaveLength(1);
});

test("cancellation while a swap is unknown or preparing preserves its original request through quote expiry", async () => {
  for (const status of ["unknown", "preparing"] as const) {
    const f = fixture(3_000_000n), cancel = new AbortController();
    f.sendWith(async (request) => f.operation(request, status));
    f.waitWith(async () => { cancel.abort(new Error("Tracking cancelled")); cancel.signal.throwIfAborted(); });
    await expect(f.run({ signal: cancel.signal })).rejects.toThrow("Tracking cancelled");
    const requestId = f.records.get(input.swapId)!.swap_request_id;
    expect(f.records.get(input.swapId)!.phase).toBe(`swap_${status}`);
    f.advance(1_300_000);
    const retryCancel = new AbortController();
    f.waitWith(async () => { retryCancel.abort(new Error("Still pending")); retryCancel.signal.throwIfAborted(); });
    await expect(f.run({ signal: retryCancel.signal })).rejects.toThrow("Still pending");
    expect(f.records.size).toBe(1); expect(f.prepared).toHaveLength(1); expect(f.sends).toHaveLength(1);
    expect(f.records.get(input.swapId)!.swap_request_id).toBe(requestId);
  }
});

test("a changed exact Wallet review returns review and requires a new invocation using the same request", async () => {
  const f = fixture(3_000_000n);
  f.sendWith(async (request) => f.operation(request, "prepared"));
  const reviewed = await f.run();
  expect(reviewed.state).toBe("review"); expect(f.sends).toHaveLength(1); expect(f.prepared).toHaveLength(1);
  f.sendWith(async (request) => f.operation(request, "confirmed"));
  const complete = await f.run();
  expect(complete.state).toBe("complete"); expect(f.sends).toHaveLength(2); expect(f.sends[1]).toEqual(f.sends[0]);
  expect(f.records.size).toBe(1); expect(f.rootCalls()).toBe(0);
});

test("a lost retry after prepared review cannot renew an expired flow using stale prepared evidence", async () => {
  const f = fixture(3_000_000n);
  f.sendWith(async (request) => f.operation(request, "prepared"));
  expect((await f.run()).state).toBe("review");
  const reviewed = structuredClone(f.records.get(input.swapId)!);
  expect(JSON.parse(reviewed.swap_operation_json!).status).toBe("prepared");
  f.sendWith(async (request) => { f.operations.set(request.requestId, f.operation(request)); throw new Error("Reply lost after reviewed swap broadcast"); });
  expect((await f.run()).state).toBe("pending");
  const dispatched = f.records.get(input.swapId)!;
  expect(dispatched.phase).toBe("swap_requested");
  expect(dispatched.swap_operation_json).toBe(reviewed.swap_operation_json);
  const submitted = f.operations.get(reviewed.swap_request_id)!;
  f.operations.clear(); f.advance(1_300_000);
  const unresolved = await f.run();
  expect(unresolved.state).toBe("pending"); expect(unresolved.swapId).toBe(input.swapId);
  expect(f.records.size).toBe(1); expect(f.prepared).toHaveLength(1); expect(f.sends).toHaveLength(2);
  expect(f.records.get(input.swapId)!.swap_request_id).toBe(reviewed.swap_request_id);
  expect(f.sends[1]).toEqual(f.sends[0]);
  f.operations.set(reviewed.swap_request_id, { ...submitted, status: "confirmed", receipt });
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(2);
});

test("flow ownership and changed arguments reject before any Wallet read, new preparation or effect", async () => {
  const f = fixture(3_000_000n); await f.run();
  f.events.length = 0;
  for (const [requested, owner, agentMode] of [
    [{ ...input, amountIn: "4000000" }, caller, true],
    [input, { ...caller, installationUid: "18" }, true],
    [input, { ...caller, appId: "another-app" }, true],
    [input, caller, false],
  ] as const) {
    await expect(runProviderSwap(f.wallet, f.store, requested, owner, agentMode, f.options)).rejects.toThrow("different inputs or a different caller");
  }
  expect(f.events).toEqual([]); expect(f.sends).toHaveLength(1); expect(f.prepared).toHaveLength(1); expect(f.records.size).toBe(1);
  expect(() => parseProviderSwapInput({ ...input, swapId: "new-id-on-each-retry" })).toThrow("reuse it for every retry");
  expect(parseProviderSwapInput(input)).toEqual(input);
});
