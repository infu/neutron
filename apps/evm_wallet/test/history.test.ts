import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";
import { encodeSelfCallResult, normalizeSelfCallResult, preflightSelfCallReply, SELF_CALL_METADATA_MAX_BYTES } from "neutron-kernel/src/self_calls.ts";
import { queryHistoryPage, queryHistoryWindow } from "../src/history.ts";
import type { SelfCallValue } from "neutron-tools/app";

const fixture = JSON.parse(await readFile(new URL("./fixtures/history-25-operations.json", import.meta.url), "utf8")) as {
  rows: number;
  metadataBytes: number;
  candidBase64: string;
  normalized: { total: string; operations: Array<Record<string, unknown> & { operation_id: string }> };
};
type PageArgs = { offset: string; limit: string };
const pageArgs = (args: SelfCallValue[]) => args[0] as PageArgs;
const aliases = extractPublicTypeAliases(await readFile(new URL("../backend/main.mo", import.meta.url), "utf8"));
const outputType = motokoTypeToIdl(aliases.evm_wallet_history_v1_Output!, IDL, aliases);
const decodedFixture = IDL.decode([outputType], Buffer.from(fixture.candidBase64, "base64"))[0] as {
  ok: { total: bigint; operations: Array<Record<string, any>> };
};

test("the captured 25-row Candid history reproduces the real Kernel metadata failure", async () => {
  const projected = normalizeSelfCallResult(decodedFixture, outputType);
  expect(projected).toEqual(fixture.normalized);
  expect(fixture.normalized.operations).toHaveLength(25);
  expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBe(71_916);
  expect(fixture.metadataBytes).toBe(71_916);
  expect(() => encodeSelfCallResult(projected)).toThrow("Self-call result exceeds the metadata byte limit");
});

test("smaller history pages retain the offset and expose every saved operation exactly once", async () => {
  const calls: PageArgs[] = [];
  async function query(method: string, args: SelfCallValue[]) {
    expect(method).toBe("evm_wallet_history_v1");
    const request = pageArgs(args);
    calls.push(request);
    const offset = Number(request.offset), limit = Number(request.limit);
    const page = { total: fixture.normalized.total, operations: fixture.normalized.operations.slice(offset, offset + limit) };
    // Use the existing Kernel transport encoder, not a copied size check.
    encodeSelfCallResult(page);
    return page;
  }
  const first = await queryHistoryPage("0", 40, query);
  expect(first.operations).toHaveLength(20);
  expect(first.total).toBe("25");
  const second = await queryHistoryPage(String(first.operations.length), 40, query);
  const ids = [...first.operations, ...second.operations].map(operation => operation.operationId);
  expect(ids).toEqual(fixture.normalized.operations.map(operation => operation.operation_id));
  expect(new Set(ids).size).toBe(25);
  expect(calls).toEqual([
    { offset: "0", limit: "40" },
    { offset: "0", limit: "20" },
    { offset: "20", limit: "40" },
  ]);
});

test("an unrelated history error propagates without retrying or skipping rows", async () => {
  for (const message of [
    "Application authorization changed",
    "Self-call result exceeds the Candid value depth limit",
    "Self-call Candid record has an invalid shape",
    "Invalid trailing data in self-call reply",
  ]) {
    const error = new Error(message);
    const calls: PageArgs[] = [];
    const result = queryHistoryPage("20", 40, async (_method, args) => {
      calls.push(pageArgs(args));
      throw error;
    });
    await expect(result).rejects.toBe(error);
    expect(calls).toEqual([{ offset: "20", limit: "40" }]);
  }
});

test("valid aggregate Candid response limits also recover through smaller pages", async () => {
  const sample = decodedFixture.ok.operations.find(row => row.intent.operation.transaction)!;
  for (const scenario of [
    { preflight: true, messageSize: 4_000, accessKeys: 0, firstError: "Self-call Candid reply exceeds the raw metadata limit" },
    { preflight: true, messageSize: 10_000, accessKeys: 0, firstError: "Candid reply exceeds the decoder allocation limit" },
    { preflight: true, messageSize: 50_000, accessKeys: 0, firstError: "Self-call Candid reply exceeds the raw byte limit" },
    { preflight: true, messageSize: 0, accessKeys: 50, firstError: "Candid reply exceeds the container element limit" },
    { preflight: false, messageSize: 0, accessKeys: 100, firstError: "Self-call value exceeds the Candid container element limit" },
  ]) {
    const transaction = {
      ...sample.intent.operation.transaction,
      access_list: [{ address: sample.address, storageKeys: Array.from({ length: scenario.accessKeys }, () => `0x${"12".repeat(32)}`) }],
    };
    const row = scenario.accessKeys ? { ...sample, intent: { ...sample.intent, operation: { transaction } } }
      : { ...sample, message: ["x".repeat(scenario.messageSize)] };
    const rows = Array.from({ length: 40 }, (_, index) => ({ ...row, operation_id: BigInt(index + 1) }));
    const calls: PageArgs[] = [], errors: string[] = [];
    const page = await queryHistoryPage("0", 40, async (_method, args) => {
      const request = pageArgs(args);
      calls.push(request);
      const offset = Number(request.offset), limit = Number(request.limit);
      const bytes = new Uint8Array(IDL.encode([outputType], [{ ok: { total: 40n, operations: rows.slice(offset, offset + limit) } }]));
      try {
        if (scenario.preflight) preflightSelfCallReply(bytes, outputType);
        const projected = normalizeSelfCallResult(IDL.decode([outputType], bytes)[0], outputType);
        encodeSelfCallResult(projected);
        return projected;
      } catch (error) {
        errors.push((error as Error).message);
        throw error;
      }
    });
    expect(errors[0]).toBe(scenario.firstError);
    expect(page.operations.length).toBeGreaterThan(0);
    expect(page.operations[0]!.operationId).toBe("1");
    expect(page.total).toBe("40");
    expect(calls.every(call => call.offset === "0")).toBe(true);
  }
});

test("a single oversized operation remains an explicit error at the same offset", async () => {
  const calls: PageArgs[] = [];
  const row = { ...fixture.normalized.operations[0], message: "x".repeat(SELF_CALL_METADATA_MAX_BYTES + 1) };
  const result = queryHistoryPage("7", 40, async (_method, args) => {
    calls.push(pageArgs(args));
    const page = { total: "8", operations: [row] };
    encodeSelfCallResult(page);
    return page;
  });
  await expect(result).rejects.toThrow("Self-call result exceeds the metadata byte limit");
  expect(calls).toEqual([40, 20, 10, 5, 2, 1].map(limit => ({ offset: "7", limit: String(limit) })));
});

function capturedRows(count: number): Array<Record<string, unknown> & { operation_id: string; request_id: string }> {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(fixture.normalized.operations[index % fixture.normalized.operations.length]),
    operation_id: String(count - index),
    request_id: (count - index).toString(16).padStart(32, "0"),
  }));
}

function capturedQuery(rows: () => ReturnType<typeof capturedRows>, calls: PageArgs[] = []) {
  return async (_method: string, args: SelfCallValue[]) => {
    const request = pageArgs(args);
    calls.push(request);
    const current = rows();
    const page = { total: String(current.length), operations: current.slice(Number(request.offset), Number(request.offset) + Number(request.limit)) };
    encodeSelfCallResult(page);
    return page;
  };
}

test("refreshing the loaded window updates an older operation beyond the adaptive first page", async () => {
  const rows = capturedRows(95);
  const query = capturedQuery(() => rows);
  const initial = await queryHistoryWindow(0, query);
  expect(initial.operations.length).toBeLessThan(40);
  const loaded = await queryHistoryWindow(initial.operations.length + 40, query);
  const olderIndex = loaded.operations.length - 1;
  expect(olderIndex).toBeGreaterThan(initial.operations.length);
  rows[olderIndex] = { ...rows[olderIndex]!, status: "confirmed", finality: "finalized" };
  const refreshed = await queryHistoryWindow(loaded.operations.length, query);
  expect(refreshed.operations.map((operation) => operation.operationId)).toEqual(loaded.operations.map((operation) => operation.operationId));
  expect(refreshed.operations[olderIndex]!.status).toBe("confirmed");
  expect(refreshed.operations[olderIndex]!.finality).toBe("finalized");
});

test("refresh and Load more retain a contiguous window after more than a page of new requests", async () => {
  let rows = capturedRows(95);
  const query = capturedQuery(() => rows);
  const loaded = await queryHistoryWindow(40, query);
  rows = [...capturedRows(140).slice(0, 45), ...rows];
  const refreshed = await queryHistoryWindow(loaded.operations.length, query);
  expect(refreshed.operations.map((operation) => operation.operationId)).toEqual(rows.slice(0, refreshed.operations.length).map((operation) => operation.operation_id));
  const extended = await queryHistoryWindow(refreshed.operations.length + 40, query);
  expect(extended.operations.map((operation) => operation.operationId)).toEqual(rows.slice(0, extended.operations.length).map((operation) => operation.operation_id));
  const complete = await queryHistoryWindow(rows.length, query);
  expect(complete.operations.map((operation) => operation.operationId)).toEqual(rows.map((operation) => operation.operation_id));
  expect(new Set(complete.operations.map((operation) => operation.operationId)).size).toBe(140);
});

test("an insertion between history pages restarts the prefix instead of accepting shifted offsets", async () => {
  let rows = capturedRows(95);
  let inserted = false;
  const calls: PageArgs[] = [];
  const read = capturedQuery(() => rows, calls);
  const result = await queryHistoryWindow(60, async (method, args) => {
    if (!inserted && Number(pageArgs(args).offset) > 0) {
      inserted = true;
      rows = [...capturedRows(140).slice(0, 45), ...rows];
    }
    return read(method, args);
  });
  expect(result.total).toBe("140");
  expect(result.operations.map((operation) => operation.operationId)).toEqual(rows.slice(0, result.operations.length).map((operation) => operation.operation_id));
  const secondPage = calls.findIndex((request) => Number(request.offset) > 0);
  expect(calls.slice(secondPage + 1).some((request) => request.offset === "0")).toBe(true);
});

test("invalid history windows fail explicitly without looping over missing or duplicated records", async () => {
  const sample = capturedRows(1)[0]!;
  for (const operations of [[], [sample]]) {
    let queries = 0;
    await expect(queryHistoryWindow(2, async () => {
      queries++;
      return { total: "2", operations: queries === 1 ? [sample] : operations };
    })).rejects.toThrow(operations.length ? "duplicate operations" : "incomplete page");
    expect(queries).toBe(2);
  }
});
