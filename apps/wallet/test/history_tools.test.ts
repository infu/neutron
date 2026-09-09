import { expect, test } from "bun:test";
import { normalizeToolDescriptor, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { validateToolResult, type MsgBusToolDescriptor } from "neutron-tools/protocol";
import { createHistoryToolHandlers, registerHistoryTools } from "../src/history_tools.ts";
import { createHistoryReader } from "../src/history_reads.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", LEDGER = "xevnm-gaaaa-aaaar-qafnq-cai", INDEX = "xrs4b-hiaaa-aaaar-qafoa-cai";
const ID = "900719925474099399999999";
function context() {
  const calls: unknown[][] = [];
  return { calls, value: { kernel: {
    querySelf: async (method: string, args: unknown[]) => {
      calls.push([method, args]);
      if (method === "wallet_snapshot") return { owner: OWNER, configured: true, ledgers: [] };
      if (method === "wallet_catalog") return [{ principal: LEDGER, index: INDEX, history_kind: "icrc" }];
      if (method === "wallet_history_page") return { records: [], next: null, has_more: false, warning: null };
      if (method === "wallet_history_status") return { running: false, ledgers: [] };
      throw new Error(`Unexpected read ${method}`);
    },
    updateSelf: async (method: string, args: unknown[], timeout: number) => {
      calls.push([method, args, timeout]);
      if (method === "wallet_history_sync") return { started_at: 1, finished_at: 2, skipped_overlap: false, ledgers: [] };
      throw new Error(`Unexpected mutation ${method}`);
    },
  } } as unknown as MsgBusToolContext };
}

test("history tools expose public read contracts with real SDK-valid result schemas", async () => {
  const descriptors = new Map<string, MsgBusToolDescriptor>();
  registerHistoryTools((name, options) => { descriptors.set(name, normalizeToolDescriptor({ name, ...options })); });
  expect([...descriptors.keys()]).toEqual(["wallet_account_transactions_v1", "wallet_transaction_v1", "wallet_history_v1"]);
  for (const descriptor of descriptors.values()) {
    expect(descriptor.annotations?.["neutron:visibility"]).toBeUndefined();
    expect(descriptor.annotations?.["neutron:effects"]).toEqual(["read", "network"]);
  }
  const reader = createHistoryReader(async () => { throw new Error("Network unavailable"); }, () => 1n);
  const handlers = createHistoryToolHandlers(reader), ctx = context();
  const account = await handlers.accountTransactions({ ledger: LEDGER }, ctx.value);
  expect(account.available).toBe(false);
  expect(() => validateToolResult(descriptors.get("wallet_account_transactions_v1")!, account)).not.toThrow();
  const transaction = await handlers.transaction({ ledger: LEDGER, blockIndex: ID }, ctx.value);
  expect(() => validateToolResult(descriptors.get("wallet_transaction_v1")!, transaction)).not.toThrow();
  const history = await handlers.history({}, ctx.value);
  expect(() => validateToolResult(descriptors.get("wallet_history_v1")!, history)).not.toThrow();
  expect(ctx.calls.every((call) => call[0] !== "wallet_history_sync")).toBe(true);
});

test("the Wallet account and index come from the invocation-scoped backend, not caller-supplied routing", async () => {
  const argsSeen: unknown[][] = [];
  const reader = { accountTransactions: async (...args: unknown[]) => { argsSeen.push(args); return {} as any; }, transaction: async (...args: unknown[]) => { argsSeen.push(args); return {} as any; } };
  const handlers = createHistoryToolHandlers(reader), ctx = context();
  await handlers.accountTransactions({ ledger: LEDGER, beforeBlock: ID, limit: 7, owner: "aaaaa-aa", index: "aaaaa-aa" }, ctx.value);
  expect(argsSeen[0]?.[0]).toEqual({ ledger: LEDGER, owner: OWNER, index: INDEX, historyKind: "icrc" });
  expect(argsSeen[0]?.slice(1, 3)).toEqual([BigInt(ID), 7n]);
  await handlers.transaction({ ledger: LEDGER, blockIndex: ID, source: "ledger" }, ctx.value);
  expect(argsSeen[1]?.slice(1, 3)).toEqual([BigInt(ID), "ledger"]);
  expect(ctx.calls.map((call) => call[0])).toEqual(["wallet_snapshot", "wallet_catalog", "wallet_snapshot", "wallet_catalog"]);
});

test("custom ledgers can receive public exact reads without inventing a canonical index", async () => {
  const argsSeen: unknown[][] = [], ctx = context();
  const handlers = createHistoryToolHandlers({ accountTransactions: async () => ({} as any), transaction: async (...args) => { argsSeen.push(args); return {} as any; } });
  await handlers.transaction({ ledger: "aaaaa-aa", blockIndex: "0" }, ctx.value);
  expect(argsSeen[0]?.[0]).toEqual({ ledger: "aaaaa-aa", owner: OWNER, index: null, historyKind: "icrc" });
});

test("history refresh invokes only the existing sync once and retains the returned coverage", async () => {
  const ctx = context(), handlers = createHistoryToolHandlers();
  const result = await handlers.history({ refresh: true, ledger: LEDGER }, ctx.value);
  expect(ctx.calls).toEqual([["wallet_history_sync", [null], 180],
    ["wallet_history_page", [{ ledger: LEDGER, limit: "50" }]], ["wallet_history_status", [null]]]);
  expect(result.sync).toEqual({ requested: true, report: { startedAt: "1", finishedAt: "2", skippedOverlap: false, results: [] }, error: null });
  expect(result.error).toBeNull(); expect(result.statusError).toBeNull();
});

test("invalid block identities are rejected before a ledger or account read", async () => {
  const ctx = context(), handlers = createHistoryToolHandlers();
  for (const blockIndex of ["01", "-1", "1e3", 12, null]) await expect(handlers.transaction({ ledger: LEDGER, blockIndex } as JsonObject, ctx.value)).rejects.toThrow();
  expect(ctx.calls).toEqual([]);
});
