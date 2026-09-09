import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { AccountIdentifier } from "@icp-sdk/canisters/ledger/icp";
import { Principal as AccountPrincipal } from "@icp-sdk/core/principal";
import {
  icpArchiveResultType, icpLedgerBlockArgsType, icpLedgerResponseType,
  readIcpAccountPage, readIcpIndexedBlocks, readIcpTransaction,
} from "../src/history_icp.ts";
import type { HistoryQuery } from "../src/history_transaction.ts";

const owner = "aaaaa-aa";
const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const index = "qhbym-qaaaa-aaaaa-aaafq-cai";
const archive = "r7inp-6aaaa-aaaaa-aaabq-cai";
const wallet = AccountIdentifier.fromPrincipal({ principal: AccountPrincipal.fromText(owner) });
const other = AccountIdentifier.fromPrincipal({ principal: AccountPrincipal.anonymous() });
const spender = AccountIdentifier.fromPrincipal({ principal: AccountPrincipal.fromText(ledger) });
const max = 18_446_744_073_709_551_615n;
type Step = { canister?: string; method: string; reply: unknown; type?: IDL.Type; check?: (request: Parameters<HistoryQuery>[0]) => void };
function script(steps: Step[]) {
  const calls: Parameters<HistoryQuery>[0][] = [];
  const query: HistoryQuery = async request => {
    calls.push(request);
    const step = steps.shift();
    if (!step) throw new Error(`Unexpected ${request.method}`);
    expect(request.method).toBe(step.method);
    if (step.canister) expect(request.canister).toBe(step.canister);
    // Exercise the same raw Candid options, nat widths, blobs and function
    // references an anonymous Actor returns. No Kernel JSON projection here.
    IDL.decode(request.argTypes, IDL.encode(request.argTypes, request.args));
    step.check?.(request);
    return IDL.decode([request.resultType], IDL.encode([step.type ?? request.resultType], [step.reply]))[0];
  };
  return { query, calls };
}
function block(operation: unknown = { Transfer: {
  from: other.toUint8Array(), to: wallet.toUint8Array(), amount: { e8s: max }, fee: { e8s: 10_000n }, spender: [spender.toUint8Array()],
} }, memo: Uint8Array | null = null) {
  return { timestamp: { timestamp_nanos: max }, transaction: {
    memo: max, icrc1_memo: memo === null ? [] : [memo], operation: operation === null ? [] : [operation],
    created_at_time: { timestamp_nanos: 8n },
  } };
}
function live(blocks: unknown[] = [block()], overrides: Record<string, unknown> = {}) {
  return { chain_length: 43n, first_block_index: 42n, blocks, archived_blocks: [], ...overrides };
}
function archivedRange(overrides: Record<string, unknown> = {}) {
  return { start: 42n, length: 1n, callback: [Principal.fromText(archive), "get_blocks"], ...overrides };
}
function indexed(id = 42n, operation: unknown = { Transfer: {
  from: other.toHex(), to: wallet.toHex(), amount: { e8s: 19n }, fee: { e8s: 2n }, spender: [spender.toHex()],
} }) {
  return { id, transaction: { memo: 5n, icrc1_memo: [], operation, timestamp: [{ timestamp_nanos: 100n }], created_at_time: [{ timestamp_nanos: 90n }] } };
}
function indexReply(transactions: unknown[] = [indexed()], oldest: bigint | null = 42n) {
  return { Ok: { balance: max, transactions, oldest_tx_id: oldest === null ? [] : [oldest] } };
}

describe("direct ICP ledger receipts", () => {
  test("preserves exact atoms, accounts, spender, memo and authoritative timestamp", async () => {
    const { query, calls } = script([{ canister: ledger, method: "query_blocks", reply: live(), check(request) {
      expect(request.args).toEqual([{ start: 42n, length: 1n }]);
      expect(request.argTypes[0]).toBe(icpLedgerBlockArgsType);
    } }]);
    const result = await readIcpTransaction(query, ledger, owner, 42n);
    expect(result).toEqual({ chainLength: "43", sourceCanister: ledger, sourceMethod: "query_blocks", archived: false,
      transaction: { blockIndex: "42", operation: "transfer", timestampNs: max.toString(), amountAtoms: max.toString(), feeAtoms: "10000",
        balanceEffectAtoms: max.toString(), from: { kind: "icp_account_identifier", accountIdentifierHex: other.toHex() },
        to: { kind: "icp_account_identifier", accountIdentifierHex: wallet.toHex() },
        spender: { kind: "icp_account_identifier", accountIdentifierHex: spender.toHex() }, memoHex: "ffffffffffffffff", memoComplete: true } });
    expect(calls).toHaveLength(1);
  });
  test("retains full ICRC memos instead of truncating receipt evidence", async () => {
    const value = block(undefined, new Uint8Array(300).fill(7));
    value.timestamp.timestamp_nanos = 0n;
    const { query } = script([{ method: "query_blocks", reply: live([value]) }]);
    const result = await readIcpTransaction(query, ledger, owner, 42n);
    expect(result.transaction?.memoHex).toBe("07".repeat(300));
    expect(result.transaction?.memoComplete).toBe(true);
    expect(result.transaction?.timestampNs).toBe("0");
  });
  test.each([
    ["outgoing", { Transfer: { from: wallet.toUint8Array(), to: other.toUint8Array(), amount: { e8s: 9n }, fee: { e8s: 2n }, spender: [] } }, "-11", "transfer"],
    ["self", { Transfer: { from: wallet.toUint8Array(), to: wallet.toUint8Array(), amount: { e8s: 9n }, fee: { e8s: 2n }, spender: [] } }, "-2", "transfer"],
    ["mint", { Mint: { to: wallet.toUint8Array(), amount: { e8s: 9n } } }, "9", "mint"],
    ["burn", { Burn: { from: wallet.toUint8Array(), amount: { e8s: 9n }, spender: [spender.toUint8Array()] } }, "-9", "burn"],
    ["approve", { Approve: { from: wallet.toUint8Array(), spender: spender.toUint8Array(), allowance: { e8s: 9n }, fee: { e8s: 2n }, expires_at: [], expected_allowance: [] } }, "-2", "approve"],
  ] as const)("normalizes %s balance effects", async (_, operation, effect, kind) => {
    const { query } = script([{ method: "query_blocks", reply: live([block(operation)]) }]);
    expect((await readIcpTransaction(query, ledger, owner, 42n)).transaction).toMatchObject({ operation: kind, amountAtoms: "9", balanceEffectAtoms: effect });
  });
  test("follows only the exact ledger-returned archive callback and preserves abort signal", async () => {
    const signal = new AbortController().signal;
    const { query, calls } = script([
      { canister: ledger, method: "query_blocks", reply: live([], { first_block_index: max, archived_blocks: [archivedRange()] }) },
      { canister: archive, method: "get_blocks", reply: { Ok: { blocks: [block()] } }, check(request) {
        expect(request.args).toEqual([{ start: 42n, length: 1n }]);
        expect(request.resultType).toBe(icpArchiveResultType);
      } },
    ]);
    expect(await readIcpTransaction(query, ledger, owner, 42n, signal)).toMatchObject({ sourceCanister: archive, sourceMethod: "get_blocks", archived: true, transaction: { blockIndex: "42" } });
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.signal === signal)).toBe(true);
  });
  test.each([
    ["wrong live index", live([block()], { first_block_index: 41n })],
    ["beyond chain", live([block()], { chain_length: 42n })],
    ["multiple live blocks", live([block(), block()])],
    ["missing existing block", live([])],
    ["conflicting sources", live([block()], { archived_blocks: [archivedRange()] })],
    ["wrong archive index", live([], { archived_blocks: [archivedRange({ start: 41n })] })],
    ["archive too long", live([], { archived_blocks: [archivedRange({ length: 2n })] })],
    ["archive empty", live([], { archived_blocks: [archivedRange({ length: 0n })] })],
    ["archive beyond chain", live([], { chain_length: 42n, archived_blocks: [archivedRange()] })],
    ["multiple archives", live([], { archived_blocks: [archivedRange(), archivedRange()] })],
    ["unsupported operation", live([block(null)])],
    ["unrelated mint", live([block({ Mint: { to: other.toUint8Array(), amount: { e8s: 9n } } })])],
    ["invalid account checksum", live([block({ Mint: { to: new Uint8Array(32), amount: { e8s: 9n } } })])],
  ])("rejects %s without querying an archive", async (_, reply) => {
    const { query, calls } = script([{ method: "query_blocks", reply }]);
    await expect(readIcpTransaction(query, ledger, owner, 42n)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  test.each([
    { Ok: { blocks: [] } }, { Ok: { blocks: [block(), block()] } },
    { Err: { BadFirstBlockIndex: { requested_index: 42n, first_valid_index: 43n } } },
    { Err: { Other: { error_code: 1n, error_message: "archive unavailable" } } },
  ])("rejects incomplete/error archive evidence", async reply => {
    const { query } = script([{ method: "query_blocks", reply: live([], { archived_blocks: [archivedRange()] }) }, { method: "get_blocks", reply }]);
    await expect(readIcpTransaction(query, ledger, owner, 42n)).rejects.toThrow();
  });
  test("missing future block is explicit and does not infer a transfer", async () => {
    const { query } = script([{ method: "query_blocks", reply: live([], { first_block_index: max, chain_length: 42n }) }]);
    expect(await readIcpTransaction(query, ledger, owner, 42n)).toMatchObject({ transaction: null, chainLength: "42", archived: false });
  });
  test("rejects block ids outside Nat64 before dispatch", async () => {
    const { query, calls } = script([]);
    await expect(readIcpTransaction(query, ledger, owner, max + 1n)).rejects.toThrow("requested block");
    await expect(readIcpTransaction(query, ledger, owner, -1n)).rejects.toThrow("requested block");
    expect(calls).toHaveLength(0);
  });
  test("ignores extra full-DID block/certificate fields", async () => {
    const fields = new Map((icpLedgerResponseType as IDL.RecordClass)._fields);
    const extra = IDL.Record({ ...Object.fromEntries(fields), certificate: IDL.Opt(IDL.Vec(IDL.Nat8)) });
    const { query } = script([{ method: "query_blocks", type: extra, reply: { ...live(), certificate: [] } }]);
    expect((await readIcpTransaction(query, ledger, owner, 42n)).transaction?.blockIndex).toBe("42");
  });
});

describe("live ICP index pages", () => {
  test("uses Nat cursors and reports a partial page with exact normalized entries", async () => {
    const { query } = script([{ canister: index, method: "get_account_transactions", reply: indexReply([indexed(42n), indexed(40n)], 38n), check(request) {
      expect(request.args).toEqual([{ account: { owner: Principal.fromText(owner), subaccount: [] }, start: [43n], max_results: 2n }]);
    } }]);
    const page = await readIcpAccountPage(query, index, owner, 43n, 2n);
    expect(page).toMatchObject({ indexedAccountBalanceAtoms: max.toString(), oldestBlock: "38", nextBeforeBlock: "40", hasMore: true, completeToOldest: false, newestAccountBlock: null });
    expect(page.transactions.map(value => value.blockIndex)).toEqual(["42", "40"]);
    expect(page.transactions[0]).toMatchObject({ timestampNs: "100", amountAtoms: "19", feeAtoms: "2", balanceEffectAtoms: "19", memoHex: "0000000000000005", memoComplete: true });
  });
  test("completion requires reaching reported oldest; fewer rows alone is insufficient", async () => {
    const { query } = script([{ method: "get_account_transactions", reply: indexReply([indexed(42n)], 40n) },
      { method: "get_account_transactions", reply: indexReply([indexed(40n)], 40n) }]);
    expect(await readIcpAccountPage(query, index, owner, null, 20n)).toMatchObject({ hasMore: true, nextBeforeBlock: "42" });
    expect(await readIcpAccountPage(query, index, owner, 42n, 20n)).toMatchObject({ hasMore: false, completeToOldest: true, nextBeforeBlock: null });
  });
  test("empty never-used account and page before oldest are terminal", async () => {
    const { query } = script([{ method: "get_account_transactions", reply: indexReply([], null) }, { method: "get_account_transactions", reply: indexReply([], 40n) }]);
    expect(await readIcpAccountPage(query, index, owner, null, 20n)).toMatchObject({ transactions: [], completeToOldest: true, newestAccountBlock: null });
    expect(await readIcpAccountPage(query, index, owner, 40n, 20n)).toMatchObject({ transactions: [], completeToOldest: true });
  });
  test("spender-only approvals advance the page without claiming a balance effect", async () => {
    const approval = indexed(42n, { Approve: { from: other.toHex(), spender: wallet.toHex(), allowance: { e8s: 1n }, fee: { e8s: 1n }, expires_at: [], expected_allowance: [] } });
    const { query } = script([{ method: "get_account_transactions", reply: indexReply([approval], 40n) }]);
    expect(await readIcpAccountPage(query, index, owner, null, 20n)).toMatchObject({ transactions: [], newestAccountBlock: "42", nextBeforeBlock: "42", hasMore: true });
  });
  test.each([
    ["overlapping cursor", indexReply([indexed(43n)]), 43n, 20n],
    ["ascending ids", indexReply([indexed(41n), indexed(42n)], 40n), null, 20n],
    ["duplicate ids", indexReply([indexed(), indexed()], 40n), null, 20n],
    ["missing oldest", indexReply([indexed()], null), null, 20n],
    ["invalid oldest", indexReply([indexed()], 43n), null, 20n],
    ["missing head", indexReply([], 40n), null, 20n],
    ["missing continuation", indexReply([], 40n), 42n, 20n],
    ["too many results", indexReply([indexed(42n), indexed(41n)], 40n), null, 1n],
    ["index failure", { Err: { message: "not ready" } }, null, 20n],
  ] as const)("rejects %s", async (_, reply, before, limit) => {
    const { query } = script([{ method: "get_account_transactions", reply }]);
    await expect(readIcpAccountPage(query, index, owner, before, limit)).rejects.toThrow();
  });
  test("creation time fallback is explicit; absent timestamps are unavailable", async () => {
    const value = indexed();
    value.transaction.timestamp = [];
    const { query } = script([{ method: "get_account_transactions", reply: indexReply([value]) },
      { method: "get_account_transactions", reply: indexReply([{ ...value, transaction: { ...value.transaction, created_at_time: [] } }]) }]);
    expect((await readIcpAccountPage(query, index, owner, null, 20n)).transactions[0]?.timestampNs).toBe("90");
    await expect(readIcpAccountPage(query, index, owner, null, 20n)).rejects.toThrow("timestamp is unavailable");
  });
  test("reads index progress separately from account balance/page results", async () => {
    const { query } = script([{ canister: index, method: "status", reply: { num_blocks_synced: max } }]);
    expect(await readIcpIndexedBlocks(query, index)).toBe(max.toString());
  });
});
