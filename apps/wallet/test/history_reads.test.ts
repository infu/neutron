import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHistoryReader, type HistoryAccount } from "../src/history_reads.ts";
import { readIcrcAccountPage, readIcrcTransaction } from "../src/history_icrc.ts";
import type { HistoryQuery } from "../src/history_transaction.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const LEDGER = "xevnm-gaaaa-aaaar-qafnq-cai", INDEX = "xrs4b-hiaaa-aaaar-qafoa-cai", ARCHIVE = "aaaaa-aa";
const ACCOUNT: HistoryAccount = { ledger: LEDGER, owner: OWNER, index: INDEX, historyKind: "icrc" };
const ID = 900719925474099312345n, AMOUNT = 900719925474099399991n;
const memo = Uint8Array.from([0, 0, 0, 0, 0, 15, 33, 163]);
const acct = (owner: string) => ({ owner: Principal.fromText(owner), subaccount: [] });
const accountValue = (owner: string) => ({ Array: [{ Blob: Principal.fromText(owner).toUint8Array() }] });
function block(amount = AMOUNT) {
  return { Map: [["btype", { Text: "1xfer" }], ["ts", { Nat: 1788951212345678901n }], ["fee", { Nat: 10000n }], ["tx", { Map: [
    ["from", accountValue(POOL)], ["to", accountValue(OWNER)], ["amt", { Nat: amount }], ["memo", { Blob: memo }],
  ] }]] };
}
function row(id = ID, amount = AMOUNT) {
  return { id, transaction: { kind: "transfer", timestamp: 1788951212345678901n, transfer: [{ from: acct(POOL), to: acct(OWNER), spender: [], amount, fee: [10000n], memo: [memo] }], mint: [], burn: [], approve: [] } };
}
function page(rows = [row()], oldest = ID) { return { Ok: { transactions: rows, balance: AMOUNT, oldest_tx_id: [oldest] } }; }
function live(value = block()) { return { log_length: ID + 1n, blocks: [{ id: ID, block: value }], archived_blocks: [] }; }
function harness(reply: (request: Parameters<HistoryQuery>[0]) => unknown) {
  const calls: Parameters<HistoryQuery>[0][] = [];
  const query: HistoryQuery = async (request) => {
    calls.push(request);
    // Actual request/response encoding catches incorrect Nat/Nat64, account,
    // recursive block and archive callback types instead of accepting mocks.
    IDL.decode(request.argTypes, IDL.encode(request.argTypes, request.args));
    return IDL.decode([request.resultType], IDL.encode([request.resultType], [reply(request)]))[0];
  };
  return { calls, query, reader: createHistoryReader(query, () => 1788951999999999999n) };
}

describe("direct ICRC ledger and canonical index observations", () => {
  test("ledger reply preserves exact credit, accounts, full memo and timestamp", async () => {
    const { reader, calls } = harness(() => live());
    const result = await reader.transaction(ACCOUNT, ID, "ledger");
    expect(result).toMatchObject({ available: true, error: null, blockIndex: ID.toString(), chainLength: (ID + 1n).toString(),
      source: { kind: "ledger", canister: LEDGER, method: "icrc3_get_blocks", ledgerVerified: true, archived: false },
      transaction: { operation: "transfer", amountAtoms: AMOUNT.toString(), balanceEffectAtoms: AMOUNT.toString(), feeAtoms: "10000",
        from: { kind: "icrc", owner: POOL, subaccountHex: null }, to: { kind: "icrc", owner: OWNER, subaccountHex: null },
        memoHex: "00000000000f21a3", memoComplete: true, timestampNs: "1788951212345678901" } });
    expect(calls).toHaveLength(1); expect(calls[0]?.args).toEqual([[{ start: ID, length: 1n }]]);
  });

  test("exact archive queries follow the canonical ledger callback and preserve its block identity", async () => {
    const { reader, calls } = harness((request) => request.canister === LEDGER
      ? { log_length: ID + 20n, blocks: [], archived_blocks: [{ args: [{ start: ID, length: 1n }], callback: [Principal.fromText(ARCHIVE), "icrc3_get_blocks"] }] }
      : { ...live(), log_length: 100000n });
    const result = await reader.transaction(ACCOUNT, ID, "ledger");
    expect(result).toMatchObject({ available: true, chainLength: (ID + 20n).toString(), source: { canister: ARCHIVE, method: "icrc3_get_blocks", archived: true, ledgerVerified: true } });
    expect(calls.map((call) => call.canister)).toEqual([LEDGER, ARCHIVE]);
    expect(calls[1]?.args).toEqual([[{ start: ID, length: 1n }]]);
  });

  test.each(["wrong ID", "archive wrong range", "archive cycle", "existing omitted", "unrelated owner", "duplicate amount", "negative amount", "unknown block type"])("%s never produces ledger proof", async (caseName) => {
    const { reader } = harness(() => {
      const value = live() as any;
      if (caseName === "wrong ID") value.blocks[0].id = ID - 1n;
      if (caseName.startsWith("archive")) { value.blocks = []; value.archived_blocks = [{ args: [{ start: caseName === "archive wrong range" ? ID + 1n : ID, length: 1n }], callback: [Principal.fromText(LEDGER), "icrc3_get_blocks"] }]; }
      if (caseName === "existing omitted") value.blocks = [];
      if (caseName === "unrelated owner") value.blocks[0].block.Map[3][1].Map[1][1] = accountValue(POOL);
      if (caseName === "duplicate amount") value.blocks[0].block.Map[3][1].Map.push(["amt", { Nat: 0n }]);
      if (caseName === "negative amount") value.blocks[0].block.Map[3][1].Map[2][1] = { Int: -1n };
      if (caseName === "unknown block type") value.blocks[0].block.Map[0][1] = { Text: "9custom" };
      return value;
    });
    const result = await reader.transaction(ACCOUNT, ID, "ledger");
    expect(result.available).toBe(false); expect(result.transaction).toBeNull(); expect(result.source.ledgerVerified).toBe(false); expect(result.error).not.toBeNull();
  });

  test("missing future blocks remain unavailable, never a zero transfer", async () => {
    const { reader } = harness(() => ({ log_length: ID, blocks: [], archived_blocks: [] }));
    const result = await reader.transaction(ACCOUNT, ID, "ledger");
    expect(result.available).toBe(false); expect(result.transaction).toBeNull(); expect(result.chainLength).toBe(ID.toString());
  });

  test("approval blocks require an explicit valid spender before becoming ledger evidence", async () => {
    const value = live() as any;
    value.blocks[0].block = { Map: [["btype", { Text: "2approve" }], ["ts", { Nat: 1n }], ["fee", { Nat: 10000n }],
      ["tx", { Map: [["from", accountValue(OWNER)], ["amt", { Nat: 5n }]] }]] };
    const { reader } = harness(() => value);
    expect(await reader.transaction(ACCOUNT, ID, "ledger")).toMatchObject({ available: false, transaction: null, source: { ledgerVerified: false } });
    value.blocks[0].block.Map[3][1].Map.push(["spender", accountValue(POOL)]);
    expect(await reader.transaction(ACCOUNT, ID, "ledger")).toMatchObject({ available: true, transaction: { operation: "approve", spender: { kind: "icrc", owner: POOL } } });
  });

  test("index pagination is exclusive and completeness reflects its oldest account ID", async () => {
    const { query, reader, calls } = harness((request) => request.method === "status" ? { num_blocks_synced: ID + 1n }
      : page([row(), row(ID - 10n)], ID - 20n));
    const first = await reader.accountTransactions(ACCOUNT, null, 2n);
    expect(first.source).toEqual({ kind: "index", canister: INDEX, ledgerVerified: false });
    expect(first.observation).toEqual({ indexedAccountBalanceAtoms: AMOUNT.toString(), newestAccountBlock: ID.toString(), indexedBlocks: (ID + 1n).toString(), indexedBlocksError: null });
    expect(first.pagination).toEqual({ beforeBlock: null, nextBeforeBlock: (ID - 10n).toString(), oldestBlock: (ID - 20n).toString(), hasMore: true, completeToOldest: false });
    expect(first.transactions[0]?.memoHex).toBe("00000000000f21a3");
    expect((calls.find((call) => call.method === "get_account_transactions")?.args[0] as any).start).toEqual([]);
    await expect(readIcrcAccountPage(query, INDEX, OWNER, ID, 2n)).rejects.toThrow("exclusive cursor");
    const final = harness(() => page([row(ID - 20n)], ID - 20n));
    const continuation = await readIcrcAccountPage(final.query, INDEX, OWNER, ID - 10n, 2n);
    expect(continuation).toMatchObject({ nextBeforeBlock: null, completeToOldest: true, newestAccountBlock: null });
  });

  test("index progress failure preserves available transactions with explicit freshness error", async () => {
    const { reader } = harness((request) => { if (request.method === "status") throw new Error("Status unsupported"); return page(); });
    const result = await reader.accountTransactions(ACCOUNT);
    expect(result.available).toBe(true); expect(result.transactions).toHaveLength(1);
    expect(result.observation.indexedBlocks).toBeNull(); expect(result.observation.indexedBlocksError).toBe("Status unsupported");
  });

  test("empty or failed index reads never impersonate complete coverage", async () => {
    const failed = harness((request) => request.method === "status" ? { num_blocks_synced: 1n } : { Err: { message: "Index unavailable" } });
    const result = await failed.reader.accountTransactions(ACCOUNT);
    expect(result).toMatchObject({ available: false, error: "Index unavailable", transactions: [], pagination: { completeToOldest: false } });
    const unsupported = await failed.reader.accountTransactions({ ...ACCOUNT, index: null });
    expect(unsupported.available).toBe(false); expect(unsupported.pagination.completeToOldest).toBe(false);
    const empty = harness(() => ({ Ok: { balance: 0n, transactions: [], oldest_tx_id: [] } }));
    expect(await readIcrcAccountPage(empty.query, INDEX, OWNER, null, 1n)).toMatchObject({ transactions: [], completeToOldest: true });
  });

  test("index fallback preserves exact evidence without ledger verification", async () => {
    const { reader, calls } = harness((request) => { if (request.method === "icrc3_get_blocks") throw new Error("Ledger temporarily unavailable"); return page(); });
    const result = await reader.transaction(ACCOUNT, ID);
    expect(result).toMatchObject({ available: true, source: { kind: "index", ledgerVerified: false }, transaction: { blockIndex: ID.toString() } });
    expect(result.diagnostics[0]).toContain("Ledger temporarily unavailable");
    expect((calls[1]?.args[0] as any).start).toEqual([ID + 1n]);
    const missing = harness(() => page([row(ID - 1n)], ID - 1n));
    expect(await missing.reader.transaction(ACCOUNT, ID, "index")).toMatchObject({ available: false, transaction: null, source: { ledgerVerified: false } });
  });

  test("full memos and zero amounts remain distinguishable from missing data", async () => {
    const longMemo = new Uint8Array(300).fill(9), value = live(block(0n)) as any;
    value.blocks[0].block.Map[3][1].Map[3][1] = { Blob: longMemo };
    const { query } = harness(() => value), result = await readIcrcTransaction(query, LEDGER, OWNER, ID);
    expect(result.transaction?.amountAtoms).toBe("0"); expect(result.transaction?.memoHex).toBe("09".repeat(300)); expect(result.transaction?.memoComplete).toBe(true);
  });

  test("cancellation prevents fallback or additional archive reads", async () => {
    const controller = new AbortController(), calls: string[] = [];
    const reader = createHistoryReader(async (request) => { calls.push(request.method); controller.abort(); throw new Error("Read interrupted"); });
    await expect(reader.transaction(ACCOUNT, ID, "auto", controller.signal)).rejects.toThrow();
    expect(calls).toEqual(["icrc3_get_blocks"]);
  });

  test("an in-flight cancellation releases the caller before an unresolved network query returns", async () => {
    const controller = new AbortController(), started = Promise.withResolvers<void>(), remote = Promise.withResolvers<unknown>();
    const calls: string[] = [];
    const reader = createHistoryReader(async (request) => { calls.push(request.method); started.resolve(); return remote.promise; });
    const result = reader.transaction(ACCOUNT, ID, "auto", controller.signal);
    await started.promise;
    controller.abort(new Error("User cancelled read"));
    await expect(result).rejects.toThrow("User cancelled read");
    remote.resolve(live());
    await Promise.resolve();
    expect(calls).toEqual(["icrc3_get_blocks"]);
  });
});
