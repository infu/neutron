import { expect, test } from "bun:test";
import { getAddress, encodeFunctionData, parseAbi } from "viem";
import type { EvmOperationResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { walletRequest, type SavedIntent, type Store, type SwapRecord } from "../src/controller.ts";
import { defaultTokens, ROUTER, QUOTER, swapTransaction, type Quote } from "../src/swap.ts";
import { continueSwap } from "../src/workflow.ts";

const address = getAddress("0x1111111111111111111111111111111111111111");
const approvalId = "11".repeat(16), swapId = "22".repeat(16);
function fixture({ approval = true, expired = false } = {}) {
  const tokens = defaultTokens("1");
  const quote: Quote = {
    chainId: "1", accountId: "main", accountAddress: address, tokenIn: tokens[1]!, tokenOut: tokens[2]!,
    amountIn: "1000000", amountOut: "2000000", minimumOut: "1990000", recipient: address,
    slippageBps: 50, deadline: String(Math.floor(Date.now() / 1000) + (expired ? -60 : 600)),
    router: ROUTER, quoter: QUOTER, fee: 500,
    gasEstimate: "90000", priceImpactBps: "10", quotedAtMs: Date.now(), blockNumber: "21000000", pool: address, routeWarnings: [],
  };
  const saved: SavedIntent = {
    quote, swap: swapTransaction(quote, 0), approval: approval ? { accountId: "main", chainId: "1", to: quote.tokenIn.address!, value: "0", data: encodeFunctionData({ abi: parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]), functionName: "approve", args: [quote.router, 1000000n] }) } : null,
    account: { accountId: "main", address, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" },
    allowance: approval ? "0" : "1000000", executionMode: "human", walletCaller: null,
  };
  let record: SwapRecord = {
    id: "saved-swap", account_id: "main", chain_id: "1", recipient: address, quote_json: JSON.stringify(saved),
    approval_request_id: approval ? approvalId : null, approval_request_json: saved.approval ? JSON.stringify(walletRequest(saved.approval, approvalId)) : null,
    swap_request_id: swapId, swap_request_json: JSON.stringify(walletRequest(saved.swap, swapId)),
    approval_operation_json: null, swap_operation_json: null, phase: "queued", revision: "0", created_at: "1", updated_at: "1",
  };
  const store = { async get() { return record; } } as unknown as Store;
  const wallet = {} as EvmWalletClient;
  function update(stage: "approval" | "swap", status: EvmOperationResult["status"]): SwapRecord {
    const operation: EvmOperationResult = {
      requestId: stage === "approval" ? approvalId : swapId, accountId: "main", chainId: "1", operationId: stage === "approval" ? "1" : "2", kind: "transaction", status,
      address, transactionHash: ["submitted", "confirmed"].includes(status) ? `0x${"88".repeat(32)}` : null,
      signature: null, reviewRevision: "1", message: null,
      receipt: status === "confirmed" ? { blockNumber: "21000001", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1", logs: [] } : null,
    };
    record = { ...record, [`${stage}_operation_json`]: JSON.stringify(operation), phase: `${stage}_${status}`, revision: String(Number(record.revision) + 1) };
    return record;
  }
  return { wallet, store, current: () => record, update };
}

test("one continuation approves, waits, requests the swap and reports its receipt", async () => {
  const f = fixture(), sends: string[] = [], progress: string[] = [];
  let pending: "approval" | "swap" | null = null;
  const result = await continueSwap(f.wallet, f.store, f.current(), {
    reconcile: async () => f.current(),
    execute: async (_wallet, _store, _record, stage) => { sends.push(stage); pending = stage; return f.update(stage, "submitted"); },
    wait: async () => { if (pending) f.update(pending, "confirmed"); },
    onProgress: (value) => progress.push(value.message),
    // A real reconcile rereads persisted Wallet evidence at each poll.
    onRecord: () => {},
  });
  expect(result.state).toBe("complete");
  expect(sends).toEqual(["approval", "swap"]);
  expect(progress).toContain("Approve token access in EVM Wallet");
  expect(progress).toContain("Confirm your swap in EVM Wallet");
});

test("a lost swap reply is reconciled before any approval or swap is requested", async () => {
  const f = fixture(); let sends = 0;
  const result = await continueSwap(f.wallet, f.store, f.current(), {
    reconcile: async (_wallet, _store, record, stage) => stage === "swap" ? f.update("swap", "confirmed") : record,
    execute: async () => { sends++; throw new Error("Must not repeat a submitted swap"); },
    wait: async () => { throw new Error("Already confirmed"); },
  });
  expect(result.state).toBe("complete"); expect(sends).toBe(0);
});

test("expired approved swaps return to fresh quote review without another transaction", async () => {
  const f = fixture({ expired: true }); f.update("approval", "confirmed");
  const result = await continueSwap(f.wallet, f.store, f.current(), {
    reconcile: async (_wallet, _store, record) => record,
    execute: async () => { throw new Error("Expired calldata cannot be submitted"); },
  });
  expect(result.state).toBe("expired");
  expect(result.record.approval_request_id).toBe(approvalId);
  expect(result.record.swap_request_id).toBe(swapId);
});

test("an expired but submitted swap is tracked without replacing its intent", async () => {
  const f = fixture({ expired: true }); f.update("swap", "submitted"); let polls = 0;
  const result = await continueSwap(f.wallet, f.store, f.current(), {
    reconcile: async (_wallet, _store, record) => polls ? f.update("swap", "confirmed") : record,
    execute: async () => { throw new Error("Never resubmit with a new request"); },
    wait: async () => { polls++; },
  });
  expect(result.state).toBe("complete"); expect(polls).toBe(1);
});

test("pausing after approval prevents automatic swap dispatch", async () => {
  const f = fixture(), controller = new AbortController(), sends: string[] = [];
  await expect(continueSwap(f.wallet, f.store, f.current(), {
    signal: controller.signal,
    reconcile: async (_wallet, _store, record) => record,
    execute: async (_wallet, _store, _record, stage) => { sends.push(stage); const next = f.update(stage, "confirmed"); controller.abort(); return next; },
  })).rejects.toThrow();
  expect(sends).toEqual(["approval"]);
});

test("a declined approval stops and retains the saved swap for an explicit retry", async () => {
  const f = fixture(), sends: string[] = [];
  const result = await continueSwap(f.wallet, f.store, f.current(), {
    reconcile: async (_wallet, _store, record) => record,
    execute: async (_wallet, _store, _record, stage) => { sends.push(stage); return f.update(stage, "rejected"); },
  });
  expect(result.state).toBe("stopped"); expect(sends).toEqual(["approval"]);
});
