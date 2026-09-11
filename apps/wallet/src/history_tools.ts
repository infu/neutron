import { queryWalletRead } from "./wallet_read.ts";
import { Principal } from "@dfinity/principal";
import { exposeTool, isJsonObject, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { createHistoryReader, type HistoryAccount } from "./history_reads.ts";
import { historyStatusSchema, historySyncReportSchema, queryHistoryPage, parseHistoryStatus, parseHistorySyncReport, type HistoryCursor } from "./history.ts";

const text: JsonObject = { type: "string" }, flag: JsonObject = { type: "boolean" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const closed = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const cursor = closed({ timestamp_ns: nat, ledger: text, kind_order: nat, id: nat });
const address: JsonObject = { oneOf: [
  closed({ kind: { const: "icrc" }, owner: text, subaccountHex: nullable(text) }),
  closed({ kind: { const: "icp_account_identifier" }, accountIdentifierHex: text }),
] };
export const walletTransactionSchema = closed({
  blockIndex: nat, operation: { enum: ["transfer", "mint", "burn", "approve"] }, timestampNs: nat,
  amountAtoms: nat, feeAtoms: nullable(nat), balanceEffectAtoms: text,
  from: nullable(address), to: nullable(address), spender: nullable(address), memoHex: nullable(text), memoComplete: flag,
});
export const walletAccountTransactionsSchema = closed({
  version: { const: 1 }, ledger: text, owner: text, observedAtNs: nat, available: flag, error: nullable(text),
  source: closed({ kind: { const: "index" }, canister: nullable(text), ledgerVerified: { const: false } }),
  transactions: { type: "array", items: walletTransactionSchema },
  pagination: closed({ beforeBlock: nullable(nat), nextBeforeBlock: nullable(nat), oldestBlock: nullable(nat), hasMore: flag, completeToOldest: flag }),
  observation: closed({ indexedAccountBalanceAtoms: nullable(nat), newestAccountBlock: nullable(nat), indexedBlocks: nullable(nat), indexedBlocksError: nullable(text) }),
});
export const walletTransactionResultSchema = closed({
  version: { const: 1 }, ledger: text, owner: text, blockIndex: nat, observedAtNs: nat, available: flag, error: nullable(text),
  transaction: nullable(walletTransactionSchema),
  source: closed({ kind: { enum: ["ledger", "index", "unavailable"] }, canister: nullable(text), method: nullable(text), ledgerVerified: flag, archived: flag }),
  chainLength: nullable(nat), diagnostics: { type: "array", items: text },
});
const annotations: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
function principal(value: unknown): string {
  if (typeof value !== "string") throw new Error("ledger must be a canonical principal");
  const parsed = Principal.fromText(value).toText(); if (parsed !== value) throw new Error("ledger must be a canonical principal"); return parsed;
}
function amount(value: unknown, label: string): bigint { if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} must be an exact nonnegative decimal integer string`); return BigInt(value); }
function limit(value: unknown): number { if (value === undefined) return 50; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("limit must be a positive integer"); return value; }
function json(value: unknown): JsonObject { return value as JsonObject; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function resolveAccount(ledger: string, context: MsgBusToolContext): Promise<HistoryAccount> {
  const [snapshot, catalog] = await Promise.all([
    queryWalletRead(context.kernel.querySelf, "snapshot"), queryWalletRead(context.kernel.querySelf, "catalog"),
  ]);
  context.signal?.throwIfAborted();
  if (!isJsonObject(snapshot) || typeof snapshot.owner !== "string" || !Array.isArray(catalog)) throw new Error("Wallet account or canonical ledger catalog unavailable");
  const owner = principal(snapshot.owner), entry = catalog.find((value) => isJsonObject(value) && value.principal === ledger);
  // Public exact ledger reads also work for custom ledgers. Only the Wallet's
  // canonical catalog may supply an index; callers cannot substitute one.
  if (!isJsonObject(entry)) return { ledger, owner, index: null, historyKind: "icrc" };
  if (entry.history_kind !== "icp" && entry.history_kind !== "icrc") throw new Error("Wallet catalog history type is unavailable");
  return { ledger, owner, index: entry.index == null ? null : principal(entry.index), historyKind: entry.history_kind };
}

export function createHistoryToolHandlers(reader = createHistoryReader()) {
  return {
    accountTransactions: async (args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> => {
      const ledger = principal(args.ledger), before = args.beforeBlock === undefined ? null : amount(args.beforeBlock, "beforeBlock");
      return json(await reader.accountTransactions(await resolveAccount(ledger, context), before, BigInt(limit(args.limit)), context.signal));
    },
    transaction: async (args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> => {
      const ledger = principal(args.ledger), block = amount(args.blockIndex, "blockIndex"), source = args.source ?? "auto";
      if (source !== "auto" && source !== "ledger" && source !== "index") throw new Error("source must be auto, ledger or index");
      return json(await reader.transaction(await resolveAccount(ledger, context), block, source, context.signal));
    },
    history: async (args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> => {
      const ledger = args.ledger === undefined ? null : principal(args.ledger), pageLimit = limit(args.limit);
      let before: HistoryCursor | null = null;
      if (args.cursor !== undefined) {
        if (!isJsonObject(args.cursor)) throw new Error("cursor must be the exact returned history cursor");
        before = { timestamp_ns: amount(args.cursor.timestamp_ns, "cursor timestamp").toString(), ledger: principal(args.cursor.ledger),
          kind_order: amount(args.cursor.kind_order, "cursor kind").toString(), id: amount(args.cursor.id, "cursor id").toString() };
      }
      let syncReport: ReturnType<typeof parseHistorySyncReport> | null = null, syncError: string | null = null;
      if (args.refresh === true) {
        try { syncReport = parseHistorySyncReport(await context.kernel.updateSelf("wallet_history_sync", [null], 180)); }
        catch (error) { context.signal?.throwIfAborted(); syncError = message(error); }
      }
      const [pageResult, statusResult] = await Promise.allSettled([
        queryHistoryPage(before, ledger, pageLimit, context.kernel.querySelf, context.signal),
        context.kernel.querySelf("wallet_history_status", [null]).then(parseHistoryStatus),
      ]);
      context.signal?.throwIfAborted();
      const page = pageResult.status === "fulfilled" ? pageResult.value : null;
      return json({ version: 1, observedAtNs: (BigInt(Date.now()) * 1_000_000n).toString(), records: page?.records.map((record) => ({ ...record, logo: null })) ?? [],
        nextCursor: page?.next ?? null, hasMore: page?.hasMore ?? false, warning: page?.warning ?? null,
        error: pageResult.status === "rejected" ? message(pageResult.reason) : null,
        status: statusResult.status === "fulfilled" ? statusResult.value : null, statusError: statusResult.status === "rejected" ? message(statusResult.reason) : null,
        sync: { requested: args.refresh === true, report: syncReport, error: syncError } });
    },
  };
}

export function registerHistoryTools(register: typeof exposeTool = exposeTool) {
  const handlers = createHistoryToolHandlers();
  register("wallet_account_transactions_v1", { title: "Read live Wallet account transactions", description: "Read one descending, exclusive-cursor page directly from this Wallet account's canonical token index, with exact amounts, accounts, complete memos and index block progress. Follow nextBeforeBlock for older records. Index coverage is an observation, not ledger verification or an operation-bound payout receipt. Missing/lagging/unsupported index data is explicit; no tokens move or history journal changes.",
    inputSchema: closed({ ledger: text, beforeBlock: nat, limit: { type: "integer", minimum: 1 } }, ["ledger"]), outputSchema: walletAccountTransactionsSchema, annotations }, handlers.accountTransactions);
  register("wallet_transaction_v1", { title: "Read an exact IC ledger transaction", description: "Read one exact block for this Wallet's default account. Auto first queries the canonical ledger and its returned archives, then falls back to the canonical index. Only a matching ledger/archive reply sets source.ledgerVerified=true; index fallback stays unverified. An exact transfer proves payment details, not which app operation caused it. Missing blocks or index lag do not prove a payout absent. Public anonymous queries only; no token transfer, allowance or mutation.",
    inputSchema: closed({ ledger: text, blockIndex: nat, source: { enum: ["auto", "ledger", "index"] } }, ["ledger", "blockIndex"]), outputSchema: walletTransactionResultSchema, annotations }, handlers.transaction);
  register("wallet_history_v1", { title: "Read Wallet activity and sync coverage", description: "Read a page of the durable Wallet activity journal and its per-ledger index/checkpoint/attempt diagnostics. Optional refresh performs the existing history synchronization once; reports retain partial, balance-only and overlapping sync outcomes. No financial action is dispatched. Cached history, empty pages and index balances do not prove a payout absent. Use live account transactions and exact ledger lookup for payout evidence.",
    inputSchema: closed({ ledger: text, cursor, limit: { type: "integer", minimum: 1 }, refresh: flag }, []),
    outputSchema: closed({ version: { const: 1 }, observedAtNs: nat, records: { type: "array", items: { type: "object" } }, nextCursor: nullable(cursor), hasMore: flag, warning: nullable(text), error: nullable(text),
      status: nullable(historyStatusSchema), statusError: nullable(text), sync: closed({ requested: flag, report: nullable(historySyncReportSchema), error: nullable(text) }) }), annotations }, handlers.history);
}
