import { expect, test } from "bun:test";
import { encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import {
  EVM_WALLET_TOOLS, type EvmOperationResult, type EvmOperationStatusResult,
  type EvmReceipt, type EvmTransactionResult, type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import { nextAgentSwapAction } from "../src/agent_workflow.ts";
import { walletRequest, type SavedIntent, type Store, type SwapRecord } from "../src/controller.ts";
import { defaultTokens, prepareSwap, QUOTER, ROUTER, swapTransaction, TOKEN_ABI, type Quote } from "../src/swap.ts";

const now = 1_800_000_000_000;
const address = getAddress("0x1111111111111111111111111111111111111111");
const caller = { appId: "agent", installationUid: "17" };
const approvalId = "11".repeat(16), swapId = "22".repeat(16);
const hashes = { approval: `0x${"aa".repeat(32)}`, swap: `0x${"bb".repeat(32)}` };
type Stage = "approval" | "swap";
function fixture({ approval = true, expired = false } = {}) {
  const tokens = defaultTokens("1");
  const quote: Quote = {
    chainId: "1", accountId: "main", accountAddress: address, tokenIn: tokens[1]!, tokenOut: tokens[0]!,
    amountIn: "3000000", amountOut: "900000000000000", minimumOut: "895500000000000", recipient: address,
    slippageBps: 50, deadline: String(now / 1000 + (expired ? -60 : 600)),
    router: ROUTER, quoter: QUOTER, fee: 500,
    gasEstimate: "90000", priceImpactBps: "10", quotedAtMs: now - (expired ? 660_000 : 0),
    blockNumber: "21000000", pool: address, routeWarnings: [],
  };
  const saved: SavedIntent = {
    quote, swap: swapTransaction(quote, 0),
    approval: approval ? { accountId: "main", chainId: "1", to: quote.tokenIn.address!, value: "0", data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ROUTER, 3_000_000n] }) } : null,
    account: { accountId: "main", address, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" },
    allowance: approval ? "0" : "3000000", executionMode: "agent", walletCaller: caller,
  };
  let record: SwapRecord = {
    id: "saved-agent-swap", account_id: "main", chain_id: "1", recipient: address, quote_json: JSON.stringify(saved),
    approval_request_id: approval ? approvalId : null, approval_request_json: saved.approval ? JSON.stringify(walletRequest(saved.approval, approvalId)) : null,
    swap_request_id: swapId, swap_request_json: JSON.stringify(walletRequest(saved.swap, swapId)),
    approval_operation_json: null, swap_operation_json: null, phase: "queued", revision: "0", created_at: "1", updated_at: "1",
  };
  const writes: string[] = [], reads: string[] = [];
  const store = {
    async get() { return record; },
    async update(previous: SwapRecord, stage: Stage, phase: string, operation: EvmOperationResult) {
      expect(previous.revision).toBe(record.revision);
      writes.push(stage);
      record = { ...record, [`${stage}_operation_json`]: JSON.stringify(operation), phase, revision: String(Number(record.revision) + 1) };
      return record;
    },
  } as unknown as Store;
  const receipt: EvmReceipt = { blockNumber: "21000001", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: String(now * 1_000_000), logs: [] };
  const chainReceipts: Record<Stage, EvmReceipt | null> = { approval: receipt, swap: receipt };
  const visible = { approval: true, swap: true };
  let bindingMatches = true;
  const wallet = {
    async accounts() { reads.push("account"); return { accounts: [saved.account] }; },
    async transaction(request: { transactionHash: string; walletRequest?: { callerAppId: string; callerInstallationUid: string; requestId: string } }): Promise<EvmTransactionResult> {
      const stage = request.transactionHash === hashes.approval ? "approval" : "swap";
      reads.push(stage);
      expect(request.walletRequest).toEqual({ callerAppId: caller.appId, callerInstallationUid: caller.installationUid, requestId: stage === "approval" ? approvalId : swapId });
      const tx = JSON.parse((stage === "approval" ? record.approval_request_json : record.swap_request_json)!);
      const actualReceipt = chainReceipts[stage];
      return {
        chainId: "1", transactionHash: hashes[stage], walletRequestMatches: bindingMatches,
        transaction: visible[stage] ? { from: address, to: tx.to, data: tx.data, valueWei: tx.valueWei, nonce: "10", blockNumber: actualReceipt?.blockNumber ?? null, blockHash: actualReceipt?.blockHash ?? null } : null,
        receipt: visible[stage] ? actualReceipt : null, observedAtNs: String(now * 1_000_000), source: "evm_rpc",
      };
    },
    async operationStatus() { throw new Error("Only the root Agent can query its Wallet operation"); },
    async sendTransactionRoot() { throw new Error("Continuation must never send a transaction"); },
    async sendTransaction() { throw new Error("Continuation must never open a nested transaction"); },
  } as unknown as EvmWalletClient;
  function operation(stage: Stage, status: EvmOperationResult["status"] = "confirmed"): EvmOperationResult {
    return {
      requestId: stage === "approval" ? approvalId : swapId, accountId: "main", chainId: "1", operationId: stage === "approval" ? "1" : "2", kind: "transaction", status,
      address, transactionHash: ["submitted", "confirmed", "signed"].includes(status) ? hashes[stage] : null,
      signature: null, reviewRevision: "1", message: null, receipt: status === "confirmed" ? receipt : null,
    };
  }
  function missing(stage: Stage): EvmOperationStatusResult { return { accountId: "main", chainId: "1", requestId: stage === "approval" ? approvalId : swapId, status: "not_found" }; }
  async function next(swap: EvmOperationStatusResult | null = null, approval: EvmOperationStatusResult | null = null) {
    return nextAgentSwapAction(wallet, store, record, caller, { swapOperationJson: swap ? JSON.stringify(swap) : null, approvalOperationJson: approval ? JSON.stringify(approval) : null }, now);
  }
  return { next, missing, operation, current: () => record, saved, receipt, chainReceipts, visible, writes, reads, store, wallet, breakBinding: () => { bindingMatches = false; } };
}

test("Agent continuation checks the original swap before any approval and does not call root tools itself", async () => {
  const f = fixture();
  const initial = await f.next();
  expect(initial.state).toBe("check_status"); expect(initial.stage).toBe("swap");
  expect(initial.nextCall?.tool).toBe(EVM_WALLET_TOOLS.operationStatus);
  expect(JSON.parse(initial.nextCall!.argsJson)).toEqual({ accountId: "main", chainId: "1", requestId: swapId });
  const approval = await f.next(f.missing("swap"));
  expect(approval.state).toBe("check_status"); expect(approval.stage).toBe("approval");
  expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
});

test("Agent receives exact approval then swap requests and only chain evidence can complete the swap", async () => {
  const f = fixture();
  const approval = await f.next(f.missing("swap"), f.missing("approval"));
  expect(approval.state).toBe("send"); expect(approval.stage).toBe("approval");
  expect(approval.nextCall?.tool).toBe(EVM_WALLET_TOOLS.sendTransactionRoot);
  expect(JSON.parse(approval.nextCall!.argsJson)).toEqual(JSON.parse(f.current().approval_request_json!));
  const swap = await f.next(f.missing("swap"), f.operation("approval"));
  expect(swap.state).toBe("send"); expect(swap.stage).toBe("swap");
  expect(JSON.parse(swap.nextCall!.argsJson)).toEqual(JSON.parse(f.current().swap_request_json));
  f.chainReceipts.swap = null;
  const pending = await f.next(f.operation("swap"), f.operation("approval"));
  expect(pending.state).toBe("wait"); expect(pending.nextCall?.tool).toBe(EVM_WALLET_TOOLS.operationStatus);
  expect(pending.pollAfterSeconds).toBe(3);
  expect(JSON.parse(f.current().swap_operation_json!).status).toBe("submitted");
  f.chainReceipts.swap = f.receipt;
  const complete = await f.next(f.operation("swap"));
  expect(complete.state).toBe("complete"); expect(complete.nextCall).toBeNull();
  expect(f.writes).toEqual(["approval", "swap", "swap"]);
});

test("an expired 3 USDC approval is verified and reused by a fresh quote without another approval", async () => {
  const f = fixture({ expired: true });
  const action = await f.next(f.missing("swap"), f.operation("approval"));
  expect(action.state).toBe("quote_expired"); expect(action.nextCall?.tool).toBe("uniswap_quote_v1");
  const input = JSON.parse(action.nextCall!.argsJson);
  expect(input).toEqual({ chainId: "1", accountId: "main", tokenIn: f.saved.quote.tokenIn.address, tokenOut: null, amountIn: "3000000", slippageBps: 50, recipient: address, deadline: String(now / 1000 + 600) });
  expect(f.current().approval_request_id).toBe(approvalId); expect(f.current().swap_request_id).toBe(swapId);
  const prepared = await prepareSwap(async () => ({ data: encodeAbiParameters([{ type: "uint256" }], [3_000_000n]), blockNumber: "21000002", observedAtMs: now }), { ...f.saved.quote, deadline: input.deadline, quotedAtMs: now }, now);
  expect(prepared.approval).toBeNull(); expect(prepared.allowance).toBe("3000000");
});

test("an expired lost swap reply remains tied to the original pending request", async () => {
  const f = fixture({ expired: true }); f.chainReceipts.swap = null;
  const action = await f.next(f.operation("swap", "submitted"));
  expect(action.state).toBe("wait"); expect(action.stage).toBe("swap");
  expect(JSON.parse(action.nextCall!.argsJson).requestId).toBe(swapId);
  expect(f.writes).toEqual(["swap"]);
  const conflicting = await f.next(f.missing("swap"), f.operation("approval"));
  expect(conflicting.state).toBe("wait"); expect(conflicting.message).toContain("conflicts");
  expect(conflicting.nextCall?.tool).toBe(EVM_WALLET_TOOLS.operationStatus);
});

test("a transaction not yet visible is a same-request wait, not a failed workflow or fresh quote", async () => {
  const f = fixture({ expired: true }); f.visible.swap = false;
  const action = await f.next(f.operation("swap", "submitted"));
  expect(action.state).toBe("wait"); expect(action.message).toContain("not yet visible");
  expect(JSON.parse(action.nextCall!.argsJson).requestId).toBe(swapId);
  expect(f.writes).toEqual([]);
});

test("in-flight preparation remains pending even after expiry", async () => {
  const f = fixture({ expired: true });
  const swap = await f.next(f.operation("swap", "preparing"), f.operation("approval"));
  expect(swap.state).toBe("wait"); expect(swap.stage).toBe("swap"); expect(f.reads).toEqual([]);
  const approval = await f.next(f.missing("swap"), f.operation("approval", "preparing"));
  expect(approval.state).toBe("wait"); expect(approval.stage).toBe("approval");
});

test("caller mismatch, wrong request identity and false Wallet binding cannot advance a swap", async () => {
  const f = fixture();
  await expect(nextAgentSwapAction(f.wallet, f.store, f.current(), { ...caller, installationUid: "18" }, { swapOperationJson: null, approvalOperationJson: null }, now)).rejects.toThrow("installation that created");
  await expect(f.next({ ...f.missing("swap"), chainId: "42161" })).rejects.toThrow();
  expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
  f.breakBinding();
  await expect(f.next(f.operation("swap"))).rejects.toThrow("exact saved caller and request ID");
  expect(f.writes).toEqual([]);
});

test("a declined request stays stopped and an unneeded approval is never invented", async () => {
  const declined = fixture({ expired: true });
  const stopped = await declined.next(declined.missing("swap"), declined.operation("approval", "rejected"));
  expect(stopped.state).toBe("stopped"); expect(stopped.nextCall).toBeNull();
  const f = fixture({ approval: false });
  const swap = await f.next(f.missing("swap"));
  expect(swap.state).toBe("send"); expect(swap.stage).toBe("swap");
  expect(f.reads).toEqual(["account"]); expect(f.writes).toEqual([]);
});


test.each(["approval", "swap"] as const)("unexpired root %s preparation returns the exact saved request for continuation", async stage => {
  const f = fixture({ approval: stage === "approval" });
  const result = stage === "approval"
    ? await f.next(f.missing("swap"), f.operation("approval", "preparing"))
    : await f.next(f.operation("swap", "preparing"));
  expect(result.state).toBe("send"); expect(result.stage).toBe(stage);
  expect(result.nextCall?.tool).toBe(EVM_WALLET_TOOLS.sendTransactionRoot);
  expect(JSON.parse(result.nextCall!.argsJson)).toEqual(JSON.parse((stage === "approval" ? f.current().approval_request_json : f.current().swap_request_json)!));
  expect(f.writes).toEqual([]);
});
