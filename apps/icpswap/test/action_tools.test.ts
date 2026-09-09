import { expect, test } from "bun:test";
import { normalizeToolDescriptor, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { createActionHandlers, registerActionTools } from "../src/action_tools.ts";
import type { ActionBackend, ActionOperation, ActionPrepared, LiquidityWire, SwapWire } from "../src/action_backend.ts";
import { createFundingRequest } from "../src/funding.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai", ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const ID = "a1".repeat(16);
const swapArgs: JsonObject = { operationId: ID, from_ledger_id: ICP, to_ledger_id: USDC, amount: "1000000", slippage: 500 };
const defaultPlan: JsonObject = { pool: POOL, owner: OWNER, funding_ledger: ICP, funding_spender: POOL, funding_amount: "1000000", token_in_fee: "10000", token_out_fee: "10000", input_address: ICP, output_address: USDC, amount_in: "1000000", amount_out_minimum: "900000", expected_out: "950000", quoted_out: "960000", decimals_in: "8", decimals_out: "6" };

function fixture(rootMode = false) {
  const records = new Map<string, ActionPrepared>(), calls: any[] = [], events: string[] = [], approvals: JsonObject[] = [];
  let executeCount = 0, deny = false, failRead = false;
  const kernel = {
    callTool: async (call: any) => {
      calls.push(call);
      if (call.name === "wallet_token_info_v1") {
        if (failRead) throw new Error("Wallet unavailable");
        const ledger = call.arguments.ledger;
        return { ledger, account: OWNER, name: ledger === ICP ? "Internet Computer" : "USD Coin", symbol: ledger === ICP ? "ICP" : "ckUSDC", decimals: ledger === ICP ? 8 : 6, feeAtoms: "10000", balanceAtoms: "100000000000", observedAtNs: "1788884400000000000" };
      }
      if (call.name === "wallet_fund_v1") { events.push("wallet"); return { status: "approved", commandId: `icpswap:${call.arguments.requestId}`, blockIndex: "42", duplicate: false, message: null }; }
      throw new Error(`Unexpected tool ${call.name}`);
    },
    updateSelf: async (method: string) => { if (method !== "icpswap_set_token_info") throw new Error("Unexpected self update"); events.push("metadata"); return true; },
  } as unknown as MsgBusToolContext["kernel"];
  const context: MsgBusToolContext = { kernel, caller: { endpoint: rootMode ? "app:agent:background" : "app:icpswap:tile:main:instance:test", appId: rootMode ? "agent" : "icpswap", role: rootMode ? "background" : "tile", installationUid: "123" }, agentMode: rootMode, reportProgress() {} };
  const prepare = (request: { id: string; input_json: string; request: SwapWire | LiquidityWire }, plan: JsonObject): ActionPrepared => {
    events.push("prepare");
    const existing = records.get(request.id); if (existing) return structuredClone(existing);
    const operation: ActionOperation = { id: request.id, input_json: request.input_json, plan_json: "", funding_json: "", state: "prepared", detail: "Prepared", result_json: "", revision: "0", created_at: "1788884400", updated_at: "1788884400", effects: [] };
    const value = { operation, plan }; records.set(request.id, value); return structuredClone(value);
  };
  const execute = async (request: { id: string; expected_revision: string }) => {
    executeCount++; events.push("execute");
    const value = records.get(request.id)!;
    if (value.operation.revision !== request.expected_revision) throw new Error("Changed operation");
    value.operation = { ...value.operation, state: "settlement_pending", detail: "Protocol confirmed; ledger payout pending.", revision: String(BigInt(value.operation.revision) + 1n) };
    return structuredClone(value);
  };
  const pool: JsonObject = { pool: POOL, protocol_diagnostics: "A payout failed and needs protocol support", transactions: [{ support_required: true }], unused0: "10000", queue: [] };
  const backend: ActionBackend = {
    actionGet: async (id) => structuredClone(records.get(id)?.operation ?? null),
    actionPage: async () => ({ items: [...records.values()].map((value) => structuredClone(value.operation)), nextCursor: null }),
    actionUpdate: async (request) => {
      const value = records.get(request.id)!;
      if (value.operation.revision !== request.expected_revision) throw new Error("Changed operation");
      value.operation = { ...value.operation, ...request, revision: String(BigInt(value.operation.revision) + 1n) }; return structuredClone(value.operation);
    },
    swapPrepare: async (request) => prepare(request, defaultPlan), swapExecute: execute, swapStatus: async (id) => structuredClone(records.get(id) ?? null),
    liquidityPrepare: async (request) => prepare(request, { request: request.request as unknown as JsonObject, pool: POOL, owner: OWNER, token0: { address: ICP, standard: "ICRC2" }, token1: { address: USDC, standard: "ICRC2" }, funding0: "0", funding1: "0", fee0: "10000", fee1: "10000", expected_amount0: "100000", expected_amount1: "100000", expected_liquidity: "10000" }),
    recoveryPrepare: async () => { throw new Error("Recovery fixture not configured"); }, recoveryExecute: execute, recoveryStatus: async (id) => structuredClone(records.get(id) ?? null),
    liquidityExecute: execute, liquidityStatus: async (id) => structuredClone(records.get(id) ?? null),
    liquidityReconcile: async (id) => ({ ...structuredClone(records.get(id)!), pool }),
    liquidityPreview: async () => ({}), liquidityPool: async () => { events.push("pool read"); return pool; }, account: async () => OWNER,
  };
  const dependencies = { backendFor: (actual: MsgBusToolContext["kernel"]) => { expect(actual).toBe(kernel); return backend; }, authorize: async (_context: MsgBusToolContext, review: JsonObject) => { approvals.push(review); events.push("review"); if (deny) throw new Error("Declined"); } };
  return { context, records, calls, events, approvals, dependencies, handlers: createActionHandlers(dependencies), executes: () => executeCount, deny: () => { deny = true; }, failReads: () => { failRead = true; } };
}

test("every current action descriptor validates with the actual Kernel SDK", () => {
  const f = fixture(); const names: string[] = [];
  registerActionTools(f.dependencies, (name, options) => { normalizeToolDescriptor({ name, ...options }); names.push(name); });
  expect(names).toContain("icpswap_reconcile_v1"); expect(names).toContain("icpswap_liquidity_quote_v1"); expect(names).not.toContain("icpswap_pool_v1");
});

test("new swaps refresh exact Wallet metadata before backend pricing and both approvals precede dispatch", async () => {
  const f = fixture();
  const result = await f.handlers.swap(swapArgs, f.context);
  expect(result.state).toBe("settlement_pending");
  expect(f.events.slice(0, 3)).toEqual(["metadata", "metadata", "prepare"]);
  expect(f.events.indexOf("review")).toBeLessThan(f.events.indexOf("wallet"));
  expect(f.events.indexOf("wallet")).toBeLessThan(f.events.indexOf("execute"));
  expect(f.executes()).toBe(1);
  const replay = await f.handlers.swap(swapArgs, f.context);
  expect(replay.state).toBe("settlement_pending"); expect(f.executes()).toBe(1);
});

test("unknown token metadata prevents a new quote rather than silently supplying zero precision", async () => {
  const f = fixture(); f.failReads();
  await expect(f.handlers.swap(swapArgs, f.context)).rejects.toThrow("Wallet unavailable");
  expect(f.events).not.toContain("prepare"); expect(f.executes()).toBe(0);
});

test("declining an exact action retains the original intent without requesting funding", async () => {
  const f = fixture(); f.deny();
  await expect(f.handlers.swap(swapArgs, f.context)).rejects.toThrow("Declined");
  expect(f.records.get(ID)?.operation.state).toBe("prepared");
  expect(f.calls.some((call) => call.name === "wallet_fund_v1")).toBe(false); expect(f.executes()).toBe(0);
});

test("Root funding handoff completes through original caller with no nested root Wallet call", async () => {
  const f = fixture(true);
  const first = await f.handlers.swap(swapArgs, f.context);
  expect(first.state).toBe("funding_required"); expect(f.executes()).toBe(0);
  const instructions = first.fundingInstructions as JsonObject[];
  const request = instructions[0]!.arguments as JsonObject;
  expect(instructions[0]!.name).toBe("wallet_fund_root_v1");
  f.failReads();
  const result = await f.handlers.continue({ operationId: ID, fundingResults: [{ status: "approved", commandId: `agent:${request.requestId}`, blockIndex: "42", duplicate: false, message: null }] }, f.context);
  expect(result.state).toBe("settlement_pending"); expect(f.executes()).toBe(1);
  expect(f.calls.some((call) => call.name === "wallet_fund_root_v1")).toBe(false);
});

test("a Root-funded operation cannot switch to human Wallet caller after an uncertain reply", async () => {
  const f = fixture(true); await f.handlers.swap(swapArgs, f.context); const before = f.calls.length;
  const changed = { ...f.context, agentMode: false };
  await expect(f.handlers.continue({ operationId: ID }, changed)).rejects.toThrow("original application and Normal or Root mode");
  expect(f.calls).toHaveLength(before); expect(f.executes()).toBe(0);
  await expect(f.handlers.continue({ operationId: ID }, { ...f.context, caller: { ...f.context.caller!, installationUid: "456" } })).rejects.toThrow("original application");
});

test("same operation cannot replace original amounts", async () => {
  const f = fixture(true); await f.handlers.swap(swapArgs, f.context);
  await expect(f.handlers.swap({ ...swapArgs, amount: "2000000" }, f.context)).rejects.toThrow("different original inputs");
  expect(f.executes()).toBe(0);
});

test("legacy calls without an ID prepare recovery identity before any funding", async () => {
  const f = fixture(); const args = { ...swapArgs }; delete args.operationId;
  const result = await f.handlers.legacySwap(args, f.context);
  expect(result.state).toBe("prepared"); expect(String(result.operationId)).toMatch(/^[0-9a-f]{32}$/);
  expect(f.approvals).toHaveLength(0); expect(f.executes()).toBe(0);
  expect(f.calls.every((call) => call.name === "wallet_token_info_v1")).toBe(true);
});

test("known expired allowance does not reach the pool even though Wallet replay says approved", async () => {
  const f = fixture(true); await f.handlers.swap(swapArgs, f.context);
  const operation = f.records.get(ID)!.operation;
  const funding = createFundingRequest({ requestId: "b2".repeat(16), ledger: ICP, spender: POOL, amountAtoms: "1000000", nowMs: Date.now() - 600_000 });
  operation.funding_json = JSON.stringify([funding]); operation.state = "funded";
  const result = await f.handlers.continue({ operationId: ID }, f.context);
  expect(result.state).toBe("funding_expired"); expect(f.executes()).toBe(0);
});

test("already credited liquidity deposits remain usable after their allowance expires", async () => {
  const f = fixture(true);
  const prepared = await f.handlers.liquidity({ operationId: ID, kind: "mint", pool: POOL, amount0: "100000", amount1: "100000", tickLower: -60, tickUpper: 60 }, f.context);
  expect(prepared.state).toBe("settlement_pending");
  const operation = f.records.get(ID)!.operation;
  operation.state = "execution_requested";
  operation.funding_json = JSON.stringify([createFundingRequest({ requestId: "b2".repeat(16), ledger: ICP, spender: POOL, amountAtoms: "100000", nowMs: Date.now() - 600_000 })]);
  operation.effects = [{ key: "deposit0", state: "succeeded" }];
  const result = await f.handlers.continue({ operationId: ID }, f.context);
  expect(result.state).toBe("settlement_pending"); expect(f.executes()).toBe(2);
});

test("reconciliation refreshes failed payout observations without changing uncertain execution", async () => {
  const f = fixture(true); await f.handlers.swap(swapArgs, f.context);
  f.records.get(ID)!.operation.state = "uncertain";
  const result = await f.handlers.reconcile({ operationId: ID }, f.context);
  expect(result.state).toBe("uncertain"); expect((result.pool as JsonObject).protocol_diagnostics).toContain("support");
  expect(f.events).toContain("pool read"); expect(f.executes()).toBe(0);
});

test("reconciliation reads Wallet candidates and explicit blocks without replaying a successful swap", async () => {
  const f = fixture(); await f.handlers.swap(swapArgs, f.context);
  const saved = f.records.get(ID)!;
  saved.operation.effects = [{ key: "swap", method: "depositFromAndSwap", canister: POOL, state: "succeeded",
    dispatched_at: "1788884400000000000", completed_at: "1788884401000000000", result_nat: "990000" }];
  const before = f.calls.length, revision = saved.operation.revision;
  const result = await f.handlers.reconcile({ operationId: ID, payoutBlocks: [{ ledger: USDC, blockIndex: "779772" }] }, f.context);
  expect(result.state).toBe("settlement_pending");
  expect(result.pool).toBeDefined();
  expect(result.walletEvidence).toMatchObject({ status: "unavailable", settlementVerified: false });
  expect(f.calls.slice(before)).toEqual([
    { target: "app:wallet:background", name: "wallet_account_transactions_v1", arguments: { ledger: USDC, limit: 25 } },
    { target: "app:wallet:background", name: "wallet_transaction_v1", arguments: { ledger: USDC, blockIndex: "779772", source: "auto" } },
  ]);
  expect(f.executes()).toBe(1); expect(saved.operation.revision).toBe(revision);
  const last = f.calls.length;
  const withoutWallet = await f.handlers.reconcile({ operationId: ID, walletEvidence: false }, f.context);
  expect(withoutWallet.pool).toBeDefined(); expect(withoutWallet).not.toHaveProperty("walletEvidence");
  expect(f.calls).toHaveLength(last);
});

test("failed account discovery retains reconciliation's protocol result", async () => {
  const f = fixture(); await f.handlers.swap(swapArgs, f.context);
  f.dependencies.backendFor(f.context.kernel).account = async () => { throw new Error("Account reader unavailable"); };
  const result = await f.handlers.reconcile({ operationId: ID }, f.context);
  expect(result.state).toBe("settlement_pending"); expect(result.pool).toBeDefined();
  expect(result.walletEvidence).toMatchObject({ status: "unavailable", errors: ["Account reader unavailable"] });
  expect(f.executes()).toBe(1);
});

test("conflicting payout read options fail before accessing a saved operation", async () => {
  const f = fixture();
  await expect(f.handlers.reconcile({ operationId: ID, walletEvidence: false, payoutBlocks: [{ ledger: USDC, blockIndex: "1" }] }, f.context)).rejects.toThrow("Enable walletEvidence");
  expect(f.events).toEqual([]); expect(f.calls).toEqual([]);
});


test("Root acknowledgments cannot substitute another Wallet command namespace", async () => {
  const f = fixture(true), first = await f.handlers.swap(swapArgs, f.context);
  const request = ((first.fundingInstructions as JsonObject[])[0]!.arguments as JsonObject);
  await expect(f.handlers.continue({ operationId: ID, fundingResults: [{ status: "approved", commandId: `icpswap:${request.requestId}`, blockIndex: "42", duplicate: false, message: null }] }, f.context)).rejects.toThrow("another calling application");
  expect(f.executes()).toBe(0);
});

test("generic status and continuation route saved recoveries without replaying deposits", async () => {
  const f = fixture();
  f.records.set(ID, { operation: { id: ID, input_json: JSON.stringify({ version: 1, kind: "recover_deposit", owner: { appId: "icpswap", installationUid: "123", rootMode: false }, input: { sourceOperationId: "ff".repeat(16), tokenIndex: 0 } }), plan_json: "", funding_json: "", result_json: "", state: "protocol_complete", detail: "Original transfer credited to unused funds", revision: "3", created_at: "1", updated_at: "1", effects: [{ key: "recover_deposit", state: "succeeded" }] }, plan: { pool: POOL } });
  expect((await f.handlers.status({ operationId: ID }, f.context)).state).toBe("protocol_complete");
  expect((await f.handlers.continue({ operationId: ID }, f.context)).state).toBe("protocol_complete");
  expect((await f.handlers.reconcile({ operationId: ID }, f.context)).pool).toBeDefined();
  expect(f.executes()).toBe(0); expect(f.approvals).toHaveLength(0);
});
