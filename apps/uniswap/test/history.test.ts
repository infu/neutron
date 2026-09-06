import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validate, type Schema } from "jsonschema";
import { encodeSelfCallResult, SELF_CALL_METADATA_MAX_BYTES } from "neutron-kernel/src/self_calls.ts";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { createSwapStore, querySwapHistoryPage, type SwapRecord } from "../src/controller.ts";

const methodSchemas = generateAppMethodSchemaArtifact(
  JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest,
  readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"),
);
type PageRequest = { cursor?: string; limit: string };
type QueryKernel = Parameters<typeof querySwapHistoryPage>[0];

function record(index: number, payloadBytes = 5_000): SwapRecord {
  return {
    id: index.toString(16).padStart(32, "0"), account_id: "main", chain_id: "1",
    recipient: `0x${"11".repeat(20)}`, quote_json: JSON.stringify({ fixture: "x".repeat(payloadBytes), amountIn: "1000000", minimumOut: "990000" }),
    approval_request_id: null, approval_request_json: null,
    swap_request_id: (index + 1000).toString(16).padStart(32, "0"),
    swap_request_json: JSON.stringify({ requestId: (index + 1000).toString(16).padStart(32, "0"), accountId: "main", chainId: "1", to: `0x${"22".repeat(20)}`, valueWei: "0", data: "0x" }),
    approval_operation_json: null, swap_operation_json: null, phase: "swap_requested", revision: "1",
    created_at: String(index), updated_at: String(index),
  };
}
function wireRecord(value: SwapRecord): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) as Record<string, string>;
}
function historyKernel(initial: SwapRecord[], options: { afterReply?: () => void } = {}) {
  const records = [...initial];
  const calls: PageRequest[] = [];
  const responseBytes: number[] = [];
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      expect(method).toBe("uniswap_history_v1");
      expect(validateAppMethodArgs(methodSchemas, method, args as Parameters<typeof validateAppMethodArgs>[2])).toEqual({ valid: true, errors: [] });
      const request = args[0] as PageRequest;
      calls.push(structuredClone(request));
      const sorted = [...records].sort((a, b) => BigInt(a.created_at) > BigInt(b.created_at) ? -1 : BigInt(a.created_at) < BigInt(b.created_at) ? 1 : b.id.localeCompare(a.id));
      const start = request.cursor === undefined ? 0 : sorted.findIndex((row) => row.id === request.cursor) + 1;
      if (request.cursor !== undefined && start === 0) throw new Error("History cursor was not found; reload history from its first page");
      const limit = Number(request.limit), rows = sorted.slice(start, start + limit);
      const page = { rows: rows.map(wireRecord), ...(start + limit < sorted.length ? { next_cursor: rows.at(-1)!.id } : {}) };
      expect(validate(page, methodSchemas.methods[method]!.output as Schema).errors.map((error) => error.stack)).toEqual([]);
      responseBytes.push(new TextEncoder().encode(JSON.stringify(page)).byteLength);
      // Exercise the actual existing Kernel metadata boundary; all row bytes
      // are preserved. A response-size failure happens before rows are returned.
      encodeSelfCallResult(page);
      options.afterReply?.();
      return page;
    },
    async updateSelf() { throw new Error("History must never mutate or submit a wallet effect"); },
  };
  return { kernel: kernel as unknown as QueryKernel, records, calls, responseBytes };
}

test("large valid history retries smaller pages at the same cursor and preserves every record byte", async () => {
  const records = Array.from({ length: 40 }, (_, index) => record(index + 1));
  const fixture = historyKernel(records);
  const first = await querySwapHistoryPage(fixture.kernel);
  expect(first.rows).toHaveLength(8);
  expect(fixture.calls).toEqual([{ limit: "32" }, { limit: "16" }, { limit: "8" }]);
  expect(fixture.responseBytes[0]!).toBeGreaterThan(SELF_CALL_METADATA_MAX_BYTES);
  expect(fixture.responseBytes[1]!).toBeGreaterThan(SELF_CALL_METADATA_MAX_BYTES);
  expect(fixture.responseBytes[2]!).toBeLessThanOrEqual(SELF_CALL_METADATA_MAX_BYTES);
  const collected = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const page = await querySwapHistoryPage(fixture.kernel, cursor);
    collected.push(...page.rows); cursor = page.nextCursor;
  }
  expect(collected).toEqual([...records].reverse());
  expect(new Set(collected.map((row) => row.id)).size).toBe(records.length);
  expect(fixture.calls.some((call) => Object.hasOwn(call, "cursor") && call.cursor === undefined)).toBe(false);
});

test("the page cursor remains anchored when newer swaps arrive between pages", async () => {
  const original = Array.from({ length: 7 }, (_, index) => record(index + 1, 5));
  const fixture = historyKernel(original);
  const first = await querySwapHistoryPage(fixture.kernel, null, 3);
  fixture.records.push(record(8, 5), record(9, 5));
  const second = await querySwapHistoryPage(fixture.kernel, first.nextCursor, 3);
  const third = await querySwapHistoryPage(fixture.kernel, second.nextCursor, 3);
  expect([...first.rows, ...second.rows, ...third.rows]).toEqual([...original].reverse());
  expect(third.nextCursor).toBeNull();
  expect(fixture.calls).toEqual([{ limit: "3" }, { cursor: original[4]!.id, limit: "3" }, { cursor: original[1]!.id, limit: "3" }]);
  expect((await querySwapHistoryPage(fixture.kernel, null, 3)).rows.map((row) => row.id)).toEqual([record(9).id, record(8).id, record(7).id]);
});

test("store page reads one page while list follows the same lossless cursor contract", async () => {
  const original = Array.from({ length: 35 }, (_, index) => record(index + 1, 3));
  const fixture = historyKernel(original);
  const store = createSwapStore(fixture.kernel as Parameters<typeof createSwapStore>[0]);
  const first = await store.page(null, 2);
  expect(first.rows.map((row) => row.id)).toEqual([...original].reverse().slice(0, 2).map((row) => row.id));
  expect(first.nextCursor).toBe(original[33]!.id);
  expect(fixture.calls).toHaveLength(1);
  expect(await store.list()).toEqual([...original].reverse());
  expect(fixture.calls.slice(1)).toEqual([{ limit: "32" }, { cursor: original[3]!.id, limit: "32" }]);
});

test("single oversized records fail explicitly without skipping their cursor", async () => {
  const anchor = record(2, 3), oversized = record(1, SELF_CALL_METADATA_MAX_BYTES + 1);
  const fixture = historyKernel([anchor, oversized]);
  await expect(querySwapHistoryPage(fixture.kernel, anchor.id)).rejects.toThrow("Self-call result exceeds the metadata byte limit");
  expect(fixture.calls).toEqual([32, 16, 8, 4, 2, 1].map((limit) => ({ cursor: anchor.id, limit: String(limit) })));
  expect(fixture.records).toEqual([anchor, oversized]);
});

test("known aggregate response-size errors halve only the current page request", async () => {
  for (const message of [
    "Self-call Candid reply exceeds the raw metadata limit", "Self-call Candid reply exceeds the raw byte limit",
    "Candid reply exceeds the container element limit", "Candid reply exceeds the decoder allocation limit", "Self-call value exceeds the Candid container element limit",
  ]) {
    const calls: PageRequest[] = [], row = record(1, 1);
    const kernel = { async querySelf(_method: string, args: unknown[]) {
      const request = args[0] as PageRequest; calls.push(request);
      if (Number(request.limit) > 1) throw new Error(message);
      return { rows: [wireRecord(row)] };
    } } as unknown as QueryKernel;
    expect(await querySwapHistoryPage(kernel, record(2).id, 3)).toEqual({ rows: [row], nextCursor: null });
    expect(calls).toEqual([{ cursor: record(2).id, limit: "3" }, { cursor: record(2).id, limit: "1" }]);
  }
});

test("unrelated failures and lookalike size messages are not retried", async () => {
  for (const message of ["Application authorization changed", "History cursor was not found; reload history from its first page", "Self-call result exceeds the Candid value depth limit", "Self-call Candid record has an invalid shape", "RPC timeout", "Self-call result exceeds the metadata byte limit (unexpected suffix)"]) {
    const error = new Error(message), calls: PageRequest[] = [];
    const kernel = { async querySelf(_method: string, args: unknown[]) { calls.push(args[0] as PageRequest); throw error; } } as unknown as QueryKernel;
    await expect(querySwapHistoryPage(kernel, record(2).id)).rejects.toBe(error);
    expect(calls).toEqual([{ cursor: record(2).id, limit: "32" }]);
  }
});

test("invalid page sizes and malformed or nonprogressing responses cannot loop or truncate history", async () => {
  const cursor = record(3).id, row = wireRecord(record(2, 1));
  let calls = 0;
  const kernel = { async querySelf() { calls += 1; return { rows: [] }; } } as unknown as QueryKernel;
  for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await expect(querySwapHistoryPage(kernel, null, limit)).rejects.toThrow();
  expect(calls).toBe(0);
  for (const response of [null, [], { rows: "not rows" }, { rows: [null] }, { rows: [row], next_cursor: 17 }, { rows: [row], next_cursor: cursor }, { rows: [], next_cursor: record(1).id }, { rows: [row], next_cursor: record(1).id }, { rows: [row, row] }]) {
    let queried = 0;
    const invalid = { async querySelf() { queried += 1; return response; } } as unknown as QueryKernel;
    await expect(querySwapHistoryPage(invalid, cursor)).rejects.toThrow();
    expect(queried).toBe(1);
  }
});
