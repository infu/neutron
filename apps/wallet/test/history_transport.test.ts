import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";
import { encodeSelfCallResult, normalizeSelfCallResult, preflightSelfCallReply } from "neutron-kernel/src/self_calls.ts";
import type { SelfCallValue } from "neutron-tools/app";
import { queryHistoryPage, type HistoryCursor } from "../src/history.ts";

const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const owner = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai");
const aliases = extractPublicTypeAliases(await readFile(new URL("../backend/main.mo", import.meta.url), "utf8"));
const outputType = motokoTypeToIdl(aliases.wallet_history_page_Output!, IDL, aliases);
const logo = `data:image/png;base64,${"A".repeat(8_192)}`;
const timestamp = 1_788_900_000_123_456_789n;
type Request = { limit: string; ledger?: string; before?: Omit<HistoryCursor, "kind_order"> & { kind_order: number }; include_logos: boolean };

test("released callers can omit the new optional history request field", () => {
  const current = motokoTypeToIdl(aliases.WalletHistoryPageRequest!, IDL, aliases);
  const old = motokoTypeToIdl(aliases.WalletHistoryPageRequest!.replace("include_logos : ?Bool;", ""), IDL, aliases);
  const bytes = IDL.encode([old], [{ ledger: [], before: [], limit: 40n }]);
  expect(IDL.decode([current], bytes)).toEqual([{ ledger: [], before: [], limit: 40n, include_logos: [] }]);
});

function rows(count: number, detailLength = 0) {
  return Array.from({ length: count }, (_, index) => ({ transaction: {
    ledger: Principal.fromText(ledger), symbol: ["ICP"], decimals: [8n], logo: [logo],
    value: {
      block_index: 9_007_199_254_740_993_999_999n - BigInt(index), operation: { transfer: null }, timestamp_ns: timestamp,
      amount: 123_456_789_012_345_678_901_234n, fee: [10_000n], balance_effect: -123_456_789_012_345_678_911_234n,
      from: [{ icrc: { owner, subaccount: [] } }], to: [], spender: [], memo: [Uint8Array.from([1, 2, 3])],
      intent: detailLength ? [{ contact_id: 1n, address_id: 2n, contact_name: "x".repeat(detailLength), address_label: [],
        network: "internet_computer", destination: owner.toText(), native: false }] : [],
      native: [], provenance: { index: null }, verification: { verified: null },
    },
  } }));
}

function wirePage(records: ReturnType<typeof rows>, hasMore = false) {
  const last = records.at(-1)?.transaction;
  return { records, inspected: BigInt(records.length), has_more: hasMore, warning: [],
    next: hasMore && last ? [{ timestamp_ns: timestamp, ledger: last.ledger, kind_order: 0, id: last.value.block_index }] : [] };
}

function transport(page: ReturnType<typeof wirePage>) {
  const bytes = new Uint8Array(IDL.encode([outputType], [page]));
  preflightSelfCallReply(bytes, outputType);
  const projected = normalizeSelfCallResult(IDL.decode([outputType], bytes)[0], outputType);
  encodeSelfCallResult(projected);
  return projected;
}

function reader(records: ReturnType<typeof rows>, calls: Request[]) {
  return async (method: string, args: SelfCallValue[]) => {
    expect(method).toBe("wallet_history_page");
    const request = args[0] as Request;
    calls.push(request);
    const start = request.before ? records.findIndex(row => row.transaction.value.block_index.toString() === request.before!.id) + 1 : 0;
    if (request.before) expect(start).toBeGreaterThan(0);
    const selected = records.slice(start, start + Number(request.limit));
    const compact = selected.map(row => ({ transaction: { ...row.transaction, logo: request.include_logos ? row.transaction.logo : [] } }));
    return transport(wirePage(compact, start + selected.length < records.length));
  };
}

test("40 Candid activity records with repeated token artwork exceed the actual Kernel metadata limit", () => {
  const page = wirePage(rows(40));
  const projected = normalizeSelfCallResult(IDL.decode([outputType], IDL.encode([outputType], [page]))[0], outputType);
  expect(() => encodeSelfCallResult(projected)).toThrow("Self-call result exceeds the metadata byte limit");
});

test("compact history fits without dropping financial fields or requiring extra pages for artwork", async () => {
  const calls: Request[] = [];
  const page = await queryHistoryPage(null, ledger, 40, reader(rows(40), calls));
  expect(calls).toEqual([{ limit: "40", ledger, include_logos: false }]);
  expect(page.records).toHaveLength(40);
  expect(page.records[0]).toMatchObject({ ledger, logo: null, kind: "transaction", blockIndex: "9007199254740993999999",
    timestampNs: timestamp.toString(), amount: "123456789012345678901234", balanceEffect: "-123456789012345678911234", memo: "010203" });
  expect(page.hasMore).toBe(false);
});

test("large records shrink the read page at its exact compound cursor and retain every row once", async () => {
  const records = rows(65, 1_500), calls: Request[] = [], read = reader(records, calls);
  const seen: string[] = [];
  let cursor: HistoryCursor | null = null;
  do {
    const callStart = calls.length;
    const page = await queryHistoryPage(cursor, ledger, 40, read);
    for (const request of calls.slice(callStart)) {
      expect(request.ledger).toBe(ledger);
      expect(request.before).toEqual(cursor ? { ...cursor, kind_order: 0 } : undefined);
      expect(request.include_logos).toBe(false);
    }
    expect(page.records.length).toBeGreaterThan(0);
    seen.push(...page.records.map(record => record.kind === "transaction" ? record.blockIndex : "unexpected adjustment"));
    cursor = page.next;
    if (!page.hasMore) break;
  } while (cursor);
  expect(calls.slice(0, 2).map(call => call.limit)).toEqual(["40", "20"]);
  expect(seen).toEqual(records.map(row => row.transaction.value.block_index.toString()));
  expect(new Set(seen).size).toBe(records.length);
});

test("a filtered empty page retains the backend continuation cursor", async () => {
  const next = { timestamp_ns: timestamp.toString(), ledger, kind_order: 0, id: "100" };
  const page = await queryHistoryPage(null, ledger, 40, async () => ({ records: [], next, inspected: "1000", has_more: true }));
  expect(page.records).toEqual([]);
  expect(page.hasMore).toBe(true);
  expect(page.next).toEqual({ ...next, kind_order: "0" });
});

test("unrelated authorization and malformed-reply errors are not retried", async () => {
  for (const message of ["Application authorization changed", "Self-call Candid record has an invalid shape", "Self-call result exceeds the Candid value depth limit"]) {
    let calls = 0;
    const error = new Error(message);
    await expect(queryHistoryPage(null, ledger, 40, async () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});

test("an oversized individual record fails explicitly instead of being skipped", async () => {
  const calls: Request[] = [];
  await expect(queryHistoryPage(null, ledger, 40, reader(rows(1, 80_000), calls))).rejects.toThrow("limit");
  expect(calls.map(call => call.limit)).toEqual(["40", "20", "10", "5", "2", "1"]);
  expect(calls.every(call => call.before === undefined && call.ledger === ledger)).toBe(true);
});

test("cancellation stops adaptive reads before another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const error = new Error("Caller stopped the tool");
  await expect(queryHistoryPage(null, ledger, 40, async () => {
    calls++; controller.abort(error); throw new Error("Self-call result exceeds the metadata byte limit");
  }, controller.signal)).rejects.toBe(error);
  expect(calls).toBe(1);
});
